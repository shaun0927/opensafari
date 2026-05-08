/**
 * Tests for proxy initialization timing (Issue #264, #701).
 *
 * Verifies:
 * - waitForProcessReady retries correctly when server is not ready
 * - waitForProcessReady succeeds when "iOS Devices" is returned
 * - waitForProcessReady throws on timeout (fatal — proxy process did not start)
 * - waitForTarget retries correctly when server is not ready
 * - waitForTarget succeeds when valid JSON array is returned
 * - waitForTarget does not throw on timeout (non-fatal, logs warning)
 * - Empty [] response is healthy (process-ready) but not target-ready
 * - start() without waitForTarget completes before target timeout
 * - WebKitClient connect() retry logic handles failures gracefully
 * - WebKitClient connect() succeeds after initial failures with retry configured
 */

// Mock child_process so that:
//   - promisify(execFile) uses mockExecFileAsync (captured at module load time in proxy.ts)
//   - spawn is a jest.fn() that tests can configure via mockSpawn.mockReturnValue(...)
// Must be hoisted (jest.mock) so proxy.ts sees the mock at import time.
const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
const mockSpawn = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: mockSpawn,
    execFile: Object.assign(
      jest.fn((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args)),
      { [Symbol.for('nodejs.util.promisify.custom')]: mockExecFileAsync },
    ),
  };
});

import { WebInspectorProxy } from '../../src/simulator/proxy';
import * as socketFinder from '../../src/simulator/socket-finder';
import { WebKitClient } from '../../src/webkit/client';
import { DEFAULT_PROXY_PROCESS_READY_TIMEOUT_MS } from '../../src/config/defaults';

// Access private methods via type cast for white-box testing
type ProxyPrivate = {
  waitForTarget(options?: { timeout?: number }): Promise<void>;
  waitForProcessReady(timeout?: number): Promise<void>;
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

  // -----------------------------------------------------------------------
  // waitForTarget (replaces old waitForForwarding — now public, opt-in)
  // -----------------------------------------------------------------------

  describe('waitForTarget', () => {
    beforeEach(() => {
      // waitForTarget requires _running = true; simulate a started proxy
      (proxy as unknown as { _running: boolean })._running = true;
    });

    it('returns immediately when server responds with a valid JSON array', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockResolvedValue('[{"id":"target1"}]');

      await expect(privateProxy(proxy).waitForTarget({ timeout: 5000 })).resolves.toBeUndefined();
      expect(httpGetSpy).toHaveBeenCalledTimes(1);
    });

    it('treats empty [] as not-target-ready and keeps retrying', async () => {
      let callCount = 0;
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callCount++;
          if (callCount < 3) return '[]';
          return '[{"id":"target1","title":"Test","url":"about:blank","webSocketDebuggerUrl":"ws://localhost/1"}]';
        });

      jest.useFakeTimers();

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });

      // Advance clock to trigger retries: adaptive polling 200ms → 400ms
      await jest.advanceTimersByTimeAsync(600);

      await waitPromise;

      expect(httpGetSpy).toHaveBeenCalledTimes(3);
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

      jest.useFakeTimers();

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });

      // Adaptive: 200ms + 400ms = 600ms for two retries
      await jest.advanceTimersByTimeAsync(600);

      await waitPromise;

      expect(httpGetSpy).toHaveBeenCalledTimes(3);
    });

    it('treats malformed JSON response as not-ready and retries', async () => {
      let callCount = 0;
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callCount++;
          if (callCount < 3) return '[ invalid json }';
          return '[{"id":"target1"}]';
        });

      jest.useFakeTimers();

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });

      // Adaptive: 200ms + 400ms = 600ms for two retries
      await jest.advanceTimersByTimeAsync(600);

      await waitPromise;

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

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });
      await jest.advanceTimersByTimeAsync(200);
      await waitPromise;

      expect(httpGetSpy).toHaveBeenCalledTimes(2);
    });

    it('does not throw when timeout expires — logs a warning instead', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      jest.useFakeTimers();

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 2000 });

      // Advance past the full timeout window
      await jest.advanceTimersByTimeAsync(3000);

      // Must resolve (not reject) — non-fatal timeout
      await expect(waitPromise).resolves.toBeUndefined();

      // Should have logged a warning with the timeout value inline
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No Safari target appeared within 2000ms'),
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

      await privateProxy(proxy).waitForTarget({ timeout: 5000 });

      expect(capturedUrls[0]).toBe(`http://localhost:${proxy.port}/json`);
    });

    it('succeeds when a target appears during the final sleep window', async () => {
      // Regression test for the boundary-poll fix: a target that appears during
      // the last sleep (after the loop guard would exit) must still be found.
      let callCount = 0;
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callCount++;
          // First 3 polls return empty; 4th (post-loop boundary poll) returns a target
          if (callCount < 4) return '[]';
          return '[{"webSocketDebuggerUrl":"ws://x"}]';
        });

      jest.useFakeTimers();

      // timeout=1000: polls at ~0ms(empty), sleep 200ms, ~200ms(empty),
      // sleep 400ms, ~600ms(empty), sleep min(800,400)=400ms → wakes at ~1000ms,
      // loop guard fails, post-loop boundary poll fires → finds target.
      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 1000 });

      // Advance past the timeout so the boundary poll fires
      await jest.advanceTimersByTimeAsync(1100);

      await expect(waitPromise).resolves.toBeUndefined();
      expect(httpGetSpy).toHaveBeenCalledTimes(4);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('uses adaptive polling — second interval is larger than the first', async () => {
      const callTimes: number[] = [];
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => {
          callTimes.push(Date.now());
          return '[]'; // never target-ready within the test window
        });

      jest.useFakeTimers();

      const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });
      // Capture first three calls: t=0, t+200, t+600 (200ms then 400ms intervals)
      await jest.advanceTimersByTimeAsync(800);

      // Resolve the promise by providing a target
      httpGetSpy.mockResolvedValue('[{"id":"t"}]');
      await jest.advanceTimersByTimeAsync(800);

      await waitPromise;

      expect(callTimes.length).toBeGreaterThanOrEqual(3);
      const gap1 = callTimes[1] - callTimes[0];
      const gap2 = callTimes[2] - callTimes[1];
      // Second gap should be larger (adaptive backoff)
      expect(gap2).toBeGreaterThan(gap1);
    });
  });

  // -----------------------------------------------------------------------
  // waitForProcessReady (renamed from waitForReady — still private)
  // -----------------------------------------------------------------------

  describe('waitForProcessReady', () => {
    it('resolves when device-list port returns "iOS Devices"', async () => {
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockResolvedValue('<html>iOS Devices</html>');

      await expect(privateProxy(proxy).waitForProcessReady(5000)).resolves.toBeUndefined();
      expect(httpGetSpy).toHaveBeenCalledTimes(1);
    });

    it('throws when timeout expires without "iOS Devices" response', async () => {
      jest.useFakeTimers();

      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async () => { throw new Error('connect ECONNREFUSED'); });

      const readyPromise = privateProxy(proxy).waitForProcessReady(1000);
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

      await privateProxy(proxy).waitForProcessReady(5000);

      expect(capturedUrls[0]).toBe(`http://localhost:${proxy.deviceListPort}`);
    });
  });

  // -----------------------------------------------------------------------
  // start() does not wait for target (process-ready only)
  // -----------------------------------------------------------------------

  describe('start() process-ready vs target-ready separation', () => {
    it('start() resolves without waiting for a target when proxy becomes process-ready quickly', async () => {
      // Simulate: proxy port not in use, device-list port not in use
      jest.spyOn(
        proxy as unknown as { isPortInUse: (port: number) => Promise<boolean> },
        'isPortInUse',
      ).mockResolvedValue(false);

      mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/ios_webkit_debug_proxy\n', stderr: '' });

      jest.spyOn(socketFinder, 'waitForSocketPath').mockResolvedValue('/tmp/fake.sock');

      // Stub spawn so no real process is started
      const fakeProc = {
        pid: 12345,
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };
      mockSpawn.mockReturnValue(fakeProc);

      // waitForProcessReady via httpGet: device-list responds immediately
      // httpGet is called by waitForProcessReady. We return 'iOS Devices' so it resolves.
      // waitForTarget is NOT called by start() — so the target URL must never be polled.
      const capturedUrls: string[] = [];
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async (url: string) => {
          capturedUrls.push(url);
          // Device-list port returns "iOS Devices" (process-ready)
          if (url.includes(String(proxy.deviceListPort))) return '<html>iOS Devices</html>';
          // Forwarding port returns empty (not target-ready) — should never be called by start()
          return '[]';
        });

      await proxy.start();

      // start() must have completed
      expect(proxy.running).toBe(true);

      // Only the device-list URL (process-ready check) should have been polled
      const forwardingPolled = capturedUrls.some(u => u.includes('/json'));
      expect(forwardingPolled).toBe(false);
    });

    it('empty [] from /json endpoint is process-healthy but not target-ready', async () => {
      // The proxy process is "healthy" if device-list responds with iOS Devices.
      // An empty [] at the forwarding port is healthy (proxy up) but not target-ready.
      httpGetSpy = jest
        .spyOn(privateProxy(proxy) as unknown as { httpGet: (url: string) => Promise<string> }, 'httpGet')
        .mockImplementation(async (url: string) => {
          if (url.includes('/json')) return '[]';
          return 'iOS Devices'; // device-list is healthy
        });

      // Process-ready check passes
      await expect(privateProxy(proxy).waitForProcessReady(1000)).resolves.toBeUndefined();

      // But waitForTarget with a short timeout should time out (empty array is not target-ready)
      // Set _running = true to satisfy the guard (process-ready was confirmed above)
      (proxy as unknown as { _running: boolean })._running = true;
      jest.useFakeTimers();
      const targetWaitPromise = privateProxy(proxy).waitForTarget({ timeout: 500 });
      await jest.advanceTimersByTimeAsync(700);
      await expect(targetWaitPromise).resolves.toBeUndefined(); // non-fatal
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No Safari target appeared within 500ms'),
      );
    });
  });
});

describe('WebInspectorProxy.start() socket discovery retry (Issue #494)', () => {
  let proxy: WebInspectorProxy;

  beforeEach(() => {
    proxy = new WebInspectorProxy({ port: 9522, deviceListPort: 9521 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('start() uses waitForSocketPath (retries socket discovery) rather than a single findSocketPath call', async () => {
    const waitForSocketPathSpy = jest
      .spyOn(socketFinder, 'waitForSocketPath')
      .mockResolvedValue(null);

    // Mock isPortInUse to return false so the port-in-use guard is skipped
    jest.spyOn(
      proxy as unknown as { isPortInUse: (port: number) => Promise<boolean> },
      'isPortInUse',
    ).mockResolvedValue(false);

    // Mock the which check — mockExecFileAsync (hoisted jest.mock) handles promisify(execFile)
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/ios_webkit_debug_proxy\n', stderr: '' });

    await expect(proxy.start()).rejects.toThrow('Web Inspector socket not found');
    expect(waitForSocketPathSpy).toHaveBeenCalledWith({ targetUdid: undefined, timeout: 10_000 });
  });
});

describe('WebInspectorProxy reuse path — no target wait', () => {
  let proxy: WebInspectorProxy;

  beforeEach(() => {
    proxy = new WebInspectorProxy({ port: 9622, deviceListPort: 9621 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuse path completes without polling the forwarding port', async () => {
    // Device-list port is "in use" and healthy — triggers reuse
    jest.spyOn(
      proxy as unknown as { isPortInUse: (port: number) => Promise<boolean> },
      'isPortInUse',
    ).mockResolvedValue(true);

    const capturedUrls: string[] = [];
    jest.spyOn(
      proxy as unknown as { httpGet: (url: string) => Promise<string> },
      'httpGet',
    ).mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      return '<html>iOS Devices</html>';
    });

    // Stub ref tracking
    jest.spyOn(
      proxy as unknown as { registerRefSync: () => void },
      'registerRefSync',
    ).mockImplementation(() => {});

    await proxy.start();

    expect(proxy.running).toBe(true);
    expect(proxy.reusing).toBe(true);

    // Must NOT have polled the forwarding port (/json)
    const forwardingPolled = capturedUrls.some(u => u.includes('/json'));
    expect(forwardingPolled).toBe(false);
  });
});

describe('WebInspectorProxy _running guards and cleanup-on-timeout', () => {
  let proxy: WebInspectorProxy;

  beforeEach(() => {
    proxy = new WebInspectorProxy({ port: 9722, deviceListPort: 9721 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('start() calls stop() and rethrows when waitForProcessReady() rejects (timeout)', async () => {
    // Setup: port checks pass, binary found, socket found, spawn returns fake proc
    jest.spyOn(
      proxy as unknown as { isPortInUse: (port: number) => Promise<boolean> },
      'isPortInUse',
    ).mockResolvedValue(false);

    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/ios_webkit_debug_proxy\n', stderr: '' });
    jest.spyOn(socketFinder, 'waitForSocketPath').mockResolvedValue('/tmp/fake.sock');

    const fakeProc = {
      pid: 99999,
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    mockSpawn.mockReturnValue(fakeProc);

    // Stub ref tracking so no filesystem I/O
    jest.spyOn(
      proxy as unknown as { registerRefSync: () => void },
      'registerRefSync',
    ).mockImplementation(() => {});
    jest.spyOn(
      proxy as unknown as { unregisterRefSync: () => number },
      'unregisterRefSync',
    ).mockReturnValue(0);

    // httpGet always fails → waitForProcessReady will time out
    jest.spyOn(
      proxy as unknown as { httpGet: (url: string) => Promise<string> },
      'httpGet',
    ).mockRejectedValue(new Error('connect ECONNREFUSED'));

    jest.useFakeTimers();

    const startPromise = proxy.start();
    // Attach rejection handler immediately
    const assertion = expect(startPromise).rejects.toThrow('did not become ready within');

    // Advance past the process-ready timeout, then past stop()'s 3000ms SIGKILL fallback
    await jest.advanceTimersByTimeAsync(DEFAULT_PROXY_PROCESS_READY_TIMEOUT_MS + 5000);

    await assertion;

    // After start() rejects, _running must be false (stop() was called)
    expect(proxy.running).toBe(false);
  });

  it('waitForTarget() throws synchronously (via rejection) if called before start()', async () => {
    // proxy is freshly constructed — not started
    await expect(privateProxy(proxy).waitForTarget({ timeout: 5000 })).rejects.toThrow(
      'WebInspectorProxy must be started before waiting for a target',
    );
  });

  it('waitForTarget() aborts mid-loop if _running is set to false between polls', async () => {
    // Manually set _running to true to simulate a started proxy
    (proxy as unknown as { _running: boolean })._running = true;

    let callCount = 0;
    jest.spyOn(
      proxy as unknown as { httpGet: (url: string) => Promise<string> },
      'httpGet',
    ).mockImplementation(async () => {
      callCount++;
      // After first poll, simulate concurrent stop() by setting _running to false
      if (callCount === 1) {
        (proxy as unknown as { _running: boolean })._running = false;
      }
      return '[]'; // not target-ready
    });

    jest.useFakeTimers();

    const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 10000 });
    // Attach rejection handler immediately
    const assertion = expect(waitPromise).rejects.toThrow(
      'WebInspectorProxy process exited while waiting for target',
    );

    // Advance to trigger first poll, then the sleep after it
    await jest.advanceTimersByTimeAsync(300);

    await assertion;

    // Should have polled exactly once before aborting
    expect(callCount).toBe(1);
  });

  it('waitForTarget() rejects (not resolves) if proxy dies right before timeout', async () => {
    // Manually set _running to true to simulate a started proxy
    (proxy as unknown as { _running: boolean })._running = true;

    let callCount = 0;
    jest.spyOn(
      proxy as unknown as { httpGet: (url: string) => Promise<string> },
      'httpGet',
    ).mockImplementation(async () => {
      callCount++;
      // On the second poll, simulate the proxy dying right before the timeout fires
      if (callCount === 2) {
        (proxy as unknown as { _running: boolean })._running = false;
      }
      return '[]'; // never target-ready
    });

    jest.useFakeTimers();

    // Short timeout so only a couple of polls fire: 200ms first interval, 400ms second
    const waitPromise = privateProxy(proxy).waitForTarget({ timeout: 500 });
    // Attach rejection handler immediately to avoid unhandled-rejection warnings
    const assertion = expect(waitPromise).rejects.toThrow(/process exited/);

    // Advance past the full timeout window so the loop exits, triggering the post-loop check
    await jest.advanceTimersByTimeAsync(700);

    await assertion;
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
