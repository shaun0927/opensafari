/**
 * Tests for proxy initialization timing (Issue #264).
 *
 * Verifies:
 * - waitForForwarding retries correctly when server is not ready
 * - waitForForwarding succeeds when valid JSON array is returned
 * - waitForForwarding does not throw on timeout (non-fatal, logs warning)
 * - WebKitClient connect() retry logic handles failures gracefully
 * - WebKitClient connect() succeeds after initial failures with retry configured
 */

import { WebInspectorProxy } from '../../src/simulator/proxy';
import * as socketFinder from '../../src/simulator/socket-finder';
import { WebKitClient } from '../../src/webkit/client';

// Access private methods via type cast for white-box testing
type ProxyPrivate = {
  waitForForwarding(timeout?: number): Promise<void>;
  waitForReady(timeout?: number): Promise<void>;
  httpGet(url: string): Promise<string>;
};

function privateProxy(proxy: WebInspectorProxy): ProxyPrivate {
  return proxy as unknown as ProxyPrivate;
}

type ClientPrivate = {
  httpGet(url: string): Promise<string>;
  listTargets(): Promise<unknown[]>;
};

function privateClient(client: WebKitClient): ClientPrivate {
  return client as unknown as ClientPrivate;
}

describe('WebInspectorProxy initialization timing', () => {
  let proxy: WebInspectorProxy;
  let httpGetSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    proxy = new WebInspectorProxy({ port: 9422, deviceListPort: 9421 });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('waitForForwarding', () => {
    it('returns immediately when server responds with a valid JSON array', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockResolvedValue('[{"id":"target1"}]');

      await expect(privateProxy(proxy).waitForForwarding(5000)).resolves.toBeUndefined();
      expect(httpGetSpy).toHaveBeenCalledTimes(1);
    });

    it('retries when server returns non-array response and eventually succeeds', async () => {
      let callCount = 0;
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callCount++;
          if (callCount < 3) {
            return 'not ready yet';
          }
          return '[{"id":"target1","title":"Test","url":"about:blank","webSocketDebuggerUrl":"ws://localhost/1"}]';
        });

      // Use fake timers to avoid real 1s delays
      jest.useFakeTimers();

      const forwardingPromise = privateProxy(proxy).waitForForwarding(10000);

      // Advance clock to trigger retries: two retries at 1s each
      await jest.advanceTimersByTimeAsync(2000);

      await forwardingPromise;

      expect(httpGetSpy).toHaveBeenCalledTimes(3);
    });

    it('retries when server throws (connection refused) and eventually succeeds', async () => {
      let callCount = 0;
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            throw new Error('connect ECONNREFUSED');
          }
          return '[{"id":"target1"}]';
        });

      jest.useFakeTimers();

      const forwardingPromise = privateProxy(proxy).waitForForwarding(10000);
      await jest.advanceTimersByTimeAsync(1000);
      await forwardingPromise;

      expect(httpGetSpy).toHaveBeenCalledTimes(2);
    });

    it('does not throw when timeout expires — logs a warning instead', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      jest.useFakeTimers();

      const forwardingPromise = privateProxy(proxy).waitForForwarding(2000);

      // Advance past the full timeout window
      await jest.advanceTimersByTimeAsync(3000);

      // Must resolve (not reject) — non-fatal timeout
      await expect(forwardingPromise).resolves.toBeUndefined();

      // Should have logged a warning
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Forwarding port not ready within timeout'),
      );
    });

    it('polls the correct forwarding port URL', async () => {
      const capturedUrls: string[] = [];
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async (url: string) => {
          capturedUrls.push(url);
          return '[{"id":"t"}]';
        });

      await privateProxy(proxy).waitForForwarding(5000);

      expect(capturedUrls[0]).toBe(`http://localhost:${proxy.port}/json`);
    });
  });

  describe('waitForReady', () => {
    it('resolves when device-list port returns "iOS Devices"', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockResolvedValue('<html>iOS Devices</html>');

      await expect(privateProxy(proxy).waitForReady(5000)).resolves.toBeUndefined();
      expect(httpGetSpy).toHaveBeenCalledTimes(1);
    });

    it('throws when timeout expires without "iOS Devices" response', async () => {
      jest.useFakeTimers();

      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => { throw new Error('connect ECONNREFUSED'); });

      const readyPromise = privateProxy(proxy).waitForReady(1000);
      // Attach the rejection handler immediately to avoid unhandled-rejection warnings
      const assertion = expect(readyPromise).rejects.toThrow('did not become ready within');

      // Advance past the timeout window (1000ms timeout + 500ms poll interval buffer)
      await jest.advanceTimersByTimeAsync(2000);

      await assertion;
    });

    it('polls the device-list port URL', async () => {
      const capturedUrls: string[] = [];
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async (url: string) => {
          capturedUrls.push(url);
          return 'iOS Devices';
        });

      await privateProxy(proxy).waitForReady(5000);

      expect(capturedUrls[0]).toBe(`http://localhost:${proxy.deviceListPort}`);
    });
  });
});

describe('WebInspectorProxy.start() socket discovery retry (Issue #494)', () => {
  let proxy: WebInspectorProxy;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    proxy = new WebInspectorProxy({ port: 9522, deviceListPort: 9521 });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('start() uses waitForSocketPath (retries socket discovery) rather than a single findSocketPath call', async () => {
    const waitForSocketPathSpy = jest
      .spyOn(socketFinder, 'waitForSocketPath')
      .mockResolvedValue(null);

    // Mock isPortInUse to return false, which mock execFile to throw for ios_webkit_debug_proxy check
    const net = require('net');
    jest.spyOn(net, 'connect').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      emitter.setTimeout = jest.fn();
      emitter.destroy = jest.fn();
      process.nextTick(() => emitter.emit('error', new Error('ECONNREFUSED')));
      return emitter;
    });

    // Mock execFile (which check) to succeed
    const childProcess = require('child_process');
    jest.spyOn(childProcess, 'execFile').mockImplementation(
      (...args: unknown[]) => {
        const cb = args[args.length - 1];
        (cb as CallableFunction)(null, { stdout: '/usr/local/bin/ios_webkit_debug_proxy\n' });
      },
    );

    await expect(proxy.start()).rejects.toThrow('Web Inspector socket not found');
    expect(waitForSocketPathSpy).toHaveBeenCalledWith({ targetUdid: undefined, timeout: 10_000 });
  });
});

describe('WebKitClient connect() retry logic', () => {
  let client: WebKitClient;
  let listTargetsSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new WebKitClient({ host: 'localhost', port: 9422 });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('throws immediately when no retries configured and first attempt fails', async () => {
    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(client.connect()).rejects.toThrow('connect ECONNREFUSED');
    expect(listTargetsSpy).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    jest.useFakeTimers();

    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockImplementation(async () => { throw new Error('connection refused'); });

    const connectPromise = client.connect({ retries: 2, retryDelay: 1000 });
    // Attach rejection handler immediately to avoid unhandled-rejection warnings
    const assertion = expect(connectPromise).rejects.toThrow('connection refused');

    // Each retry delay requires advancing time separately so the async loop proceeds.
    // attempt 0 fails → 1s delay → attempt 1 fails → 1s delay → attempt 2 fails (final)
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(listTargetsSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('logs a retry message on each failed attempt except the last', async () => {
    jest.useFakeTimers();

    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockImplementation(async () => { throw new Error('connection refused'); });

    const connectPromise = client.connect({ retries: 1, retryDelay: 500 });
    // Attach rejection handler immediately to avoid unhandled-rejection warnings
    const assertion = expect(connectPromise).rejects.toThrow();

    // attempt 0 fails → 500ms delay → attempt 1 fails (final, no log)
    await jest.advanceTimersByTimeAsync(500);

    await assertion;

    // Should have logged one retry message (after first failure, before second attempt)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Connect attempt 1 failed'),
    );
  });

  it('succeeds when a later attempt finds targets', async () => {
    const mockTarget = {
      id: 'page-1',
      title: 'Test Page',
      url: 'about:blank',
      webSocketDebuggerUrl: 'ws://localhost:9422/devtools/page/page-1',
    };

    let callCount = 0;
    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error('not ready yet');
        return [mockTarget];
      });

    // Also mock connectToTarget so we don't attempt a real WebSocket connection
    const connectToTargetSpy = jest
      .spyOn(client as unknown as { connectToTarget: (url: string) => Promise<void> }, 'connectToTarget')
      .mockResolvedValue(undefined);

    jest.useFakeTimers();

    const connectPromise = client.connect({ retries: 3, retryDelay: 1000 });

    // Two failures, then success on attempt 3
    await jest.advanceTimersByTimeAsync(2000);

    await connectPromise;

    expect(listTargetsSpy).toHaveBeenCalledTimes(3);
    expect(connectToTargetSpy).toHaveBeenCalledWith(mockTarget.webSocketDebuggerUrl);
  });

  it('throws ConnectionError when targets list is empty', async () => {
    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockResolvedValue([]);

    await expect(client.connect()).rejects.toThrow('No Safari targets found');
  });

  it('uses custom retryDelay between attempts', async () => {
    jest.useFakeTimers();

    const callTimes: number[] = [];

    listTargetsSpy = jest
      .spyOn(privateClient(client) as unknown as { listTargets: () => Promise<unknown[]> }, 'listTargets')
      .mockImplementation(async () => {
        callTimes.push(Date.now());
        throw new Error('not ready');
      });

    const connectPromise = client.connect({ retries: 2, retryDelay: 3000 });
    // Attach rejection handler immediately to avoid unhandled-rejection warnings
    const assertion = expect(connectPromise).rejects.toThrow('not ready');

    // Advance 3s for first retry delay, then 3s for second retry delay
    await jest.advanceTimersByTimeAsync(3000);
    await jest.advanceTimersByTimeAsync(3000);

    await assertion;

    expect(callTimes).toHaveLength(3); // initial + 2 retries
    // The second and third calls should have happened 3000ms after the previous call
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(3000);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(3000);
  });
});
