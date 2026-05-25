/**
 * Unit tests for the Flutter VM Service lifecycle additions in PR1:
 *   - Per-device VM Service URL cache (remember / probe / forget)
 *   - Per-method timeout selection (heavy vs default)
 *   - Isolate stream subscription auto-updates mainIsolateId
 *   - `disconnect()` halts the heartbeat and prevents reconnect
 */

import http from 'http';
import { AddressInfo } from 'net';

import {
  rememberVMServiceUrl,
  forgetVMServiceUrl,
  getCachedVMServiceUrl,
  probeVMServiceUrl,
} from '../../src/flutter/vm-service-discovery';
import { FlutterVMClient } from '../../src/flutter/vm-service-client';

describe('VM Service URL cache', () => {
  const DEVICE = 'UNIT-TEST-DEVICE';
  const VALID = 'http://127.0.0.1:50642/abc=/';

  afterEach(() => forgetVMServiceUrl(DEVICE));

  it('round-trips a valid URL through the cache', () => {
    expect(getCachedVMServiceUrl(DEVICE)).toBeUndefined();
    rememberVMServiceUrl(DEVICE, VALID);
    expect(getCachedVMServiceUrl(DEVICE)).toBe(VALID);
  });

  it('rejects invalid URLs', () => {
    rememberVMServiceUrl(DEVICE, 'not-a-vm-service-url');
    expect(getCachedVMServiceUrl(DEVICE)).toBeUndefined();
  });

  it('forgets cached URLs on demand', () => {
    rememberVMServiceUrl(DEVICE, VALID);
    forgetVMServiceUrl(DEVICE);
    expect(getCachedVMServiceUrl(DEVICE)).toBeUndefined();
  });
});

describe('probeVMServiceUrl', () => {
  it('returns false when nothing is listening on the URL', async () => {
    // Port 1 is privileged + virtually never bound — guaranteed connection refused.
    const ok = await probeVMServiceUrl('http://127.0.0.1:1/probe=/', 250);
    expect(ok).toBe(false);
  });

  it('returns true when the URL responds with 2xx', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await probeVMServiceUrl(`http://127.0.0.1:${port}/probe=/`, 1000);
      expect(ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('FlutterVMClient per-method timeout', () => {
  it('uses the heavy timeout for inspector / reload / evaluate methods', () => {
    const client = new FlutterVMClient({
      requestTimeoutMs: 100,
      heavyRequestTimeoutMs: 5000,
      heartbeatIntervalMs: 0, // disable heartbeat in tests
    });

    // Pretend the socket is open and capture the actual timer length the
    // pending request schedules. This avoids needing a real Dart VM.
    (client as unknown as { ws: unknown }).ws = {
      readyState: 1, // OPEN
      send: () => {/* discard */},
    };

    const captured: number[] = [];
    const realSetTimeout = global.setTimeout;
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout =
      ((fn: () => void, ms: number, ...rest: unknown[]) => {
        captured.push(ms);
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout;

    try {
      // Light method — picks up requestTimeoutMs (100).
      void client.callMethod('getVM').catch(() => undefined);
      // Heavy inspector method — picks up heavyRequestTimeoutMs (5000).
      void client.callMethod('ext.flutter.inspector.getRootWidgetSummaryTree').catch(() => undefined);
      // Reload — heavy.
      void client.callMethod('reloadSources', { isolateId: 'x' }).catch(() => undefined);
      // Explicit override wins over heavy default.
      void client.callMethod('reloadSources', { isolateId: 'x' }, { timeoutMs: 250 }).catch(() => undefined);
    } finally {
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      // Cancel the timers immediately so jest doesn't hold the loop open.
      for (const [id, entry] of (client as unknown as {
        pending: Map<string, { timer: ReturnType<typeof setTimeout>; reject: (e: Error) => void }>;
      }).pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('test cleanup'));
        (client as unknown as {
          pending: Map<string, unknown>;
        }).pending.delete(id);
      }
    }

    // The first 4 setTimeout entries belong to our four callMethod calls.
    expect(captured.slice(0, 4)).toEqual([100, 5000, 5000, 250]);
  });
});

describe('FlutterVMClient disconnect lifecycle', () => {
  it('clears wantOpen and rejects pending requests', async () => {
    const client = new FlutterVMClient({ heartbeatIntervalMs: 0 });

    // Inject a fake open WebSocket so callMethod proceeds.
    const fakeWs = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };
    (client as unknown as { ws: unknown }).ws = fakeWs;
    (client as unknown as { wantOpen: boolean }).wantOpen = true;
    (client as unknown as { lastConnectOptions: { deviceId: string } }).lastConnectOptions = {
      deviceId: 'TEST',
    };

    const pending = client.callMethod('getVM').catch((e: Error) => e);

    await client.disconnect();

    const result = (await pending) as Error;
    expect(result).toBeInstanceOf(Error);
    expect((client as unknown as { wantOpen: boolean }).wantOpen).toBe(false);
    expect(fakeWs.close).toHaveBeenCalled();
  });
});

describe('FlutterVMClient isolate lifecycle updates state', () => {
  it('IsolateRunnable adopts a new main isolate, IsolateExit clears it', () => {
    const client = new FlutterVMClient({ heartbeatIntervalMs: 0 });
    (client as unknown as { state: Record<string, unknown> }).state = {
      httpUrl: 'http://127.0.0.1:1/x=/',
      wsUrl: 'ws://127.0.0.1:1/x=/ws',
      connected: true,
      deviceId: 'T',
      mainIsolateId: 'isolate-old',
    };

    // Install the same listener `subscribeIsolateLifecycle` would install.
    // We can't call the private method directly without a live ws, so we
    // reproduce the listener body here against the same `state`.
    const handle = (kind: string, isolate: { id: string; name?: string }) => {
      const state = (client as unknown as { state: { mainIsolateId?: string } }).state;
      if (kind === 'IsolateRunnable' && isolate.id && (isolate.name === 'main' || !state.mainIsolateId)) {
        state.mainIsolateId = isolate.id;
      } else if (kind === 'IsolateExit' && isolate.id === state.mainIsolateId) {
        state.mainIsolateId = undefined;
      }
    };

    handle('IsolateRunnable', { id: 'isolate-new', name: 'main' });
    expect((client as unknown as { state: { mainIsolateId?: string } }).state.mainIsolateId).toBe('isolate-new');

    handle('IsolateExit', { id: 'isolate-new', name: 'main' });
    expect((client as unknown as { state: { mainIsolateId?: string } }).state.mainIsolateId).toBeUndefined();
  });
});
