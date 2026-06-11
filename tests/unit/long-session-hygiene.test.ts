/**
 * Long-session hygiene (issue #848):
 * - HAR collector entry cap + body-size precheck before the RPC fetch
 * - bounded per-session log collector maps (LRU eviction)
 * - watchdog/pool monitor timers are unref()'d
 */
import { EventEmitter } from 'events';
import { HarCollector } from '../../src/network/har-collector';
import {
  BufferedEventCollector,
  CollectedEvent,
  MAX_SESSION_COLLECTORS,
  getOrCreateSessionCollector,
} from '../../src/utils/buffered-event-collector';
import { SimulatorPool } from '../../src/simulator/pool';
import { SimulatorCrashWatcher } from '../../src/reliability/crash-watcher';
import { SimulatorMonitor } from '../../src/watchdog/simulator-monitor';

class MockWebKitClient extends EventEmitter {
  public sendCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async enableDomain(_domain: string): Promise<void> {}
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sendCalls.push({ method, params });
    if (method === 'Network.getResponseBody') {
      return { body: '{"key":"value"}', base64Encoded: false } as T;
    }
    return {} as T;
  }
}

function simulateRequest(client: MockWebKitClient, requestId: string): void {
  client.emit('Network.requestWillBeSent', {
    requestId,
    timestamp: Date.now() / 1000,
    request: { url: `https://example.com/${requestId}`, method: 'GET', headers: {} },
  });
}

function simulateResponse(
  client: MockWebKitClient,
  requestId: string,
  encodedDataLength: number,
): void {
  client.emit('Network.responseReceived', {
    requestId,
    timestamp: Date.now() / 1000,
    response: {
      url: `https://example.com/${requestId}`,
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
      encodedDataLength,
    },
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('HarCollector entry cap', () => {
  test('stops storing entries at maxEntries and counts the dropped rest', async () => {
    const client = new MockWebKitClient();
    const collector = new HarCollector(client as any, { maxEntries: 3 });
    await collector.start();

    for (let i = 0; i < 5; i++) simulateRequest(client, `req-${i}`);

    expect(collector.getEntryCount()).toBe(3);
    expect(collector.getDroppedCount()).toBe(2);
    collector.stop();
  });

  test('logs the dropped count on stop', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const client = new MockWebKitClient();
    const collector = new HarCollector(client as any, { maxEntries: 1 });
    await collector.start();

    simulateRequest(client, 'req-0');
    simulateRequest(client, 'req-1');
    collector.stop();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropped 1 request(s) beyond maxEntries=1'),
    );
    errorSpy.mockRestore();
  });

  test('a new start() resets the dropped counter', async () => {
    const client = new MockWebKitClient();
    const collector = new HarCollector(client as any, { maxEntries: 1 });
    await collector.start();
    simulateRequest(client, 'req-0');
    simulateRequest(client, 'req-1');
    collector.stop();

    await collector.start();
    expect(collector.getDroppedCount()).toBe(0);
    collector.stop();
  });
});

describe('HarCollector body-size precheck', () => {
  test('skips the getResponseBody RPC when encodedDataLength exceeds maxBodySize', async () => {
    const client = new MockWebKitClient();
    const collector = new HarCollector(client as any, { captureBody: true, maxBodySize: 10 });
    await collector.start();

    simulateRequest(client, 'req-big');
    simulateResponse(client, 'req-big', 1_000_000);
    await flush();

    const bodyFetches = client.sendCalls.filter((c) => c.method === 'Network.getResponseBody');
    expect(bodyFetches).toHaveLength(0);
    collector.stop();
  });

  test('still fetches the body when the size fits', async () => {
    const client = new MockWebKitClient();
    const collector = new HarCollector(client as any, { captureBody: true, maxBodySize: 1024 });
    await collector.start();

    simulateRequest(client, 'req-small');
    simulateResponse(client, 'req-small', 64);
    await flush();

    const bodyFetches = client.sendCalls.filter((c) => c.method === 'Network.getResponseBody');
    expect(bodyFetches).toHaveLength(1);
    collector.stop();
  });
});

describe('getOrCreateSessionCollector LRU bound', () => {
  type Entry = CollectedEvent & { message: string };

  test('evicts the least-recently-used session beyond the cap', () => {
    const map = new Map<string, BufferedEventCollector<Entry>>();
    for (let i = 0; i < MAX_SESSION_COLLECTORS; i++) {
      getOrCreateSessionCollector(map, `session-${i}`);
    }
    // Touch session-0 so it becomes most-recently-used.
    getOrCreateSessionCollector(map, 'session-0');

    getOrCreateSessionCollector(map, 'session-new');

    expect(map.size).toBe(MAX_SESSION_COLLECTORS);
    expect(map.has('session-0')).toBe(true); // refreshed, not evicted
    expect(map.has('session-1')).toBe(false); // oldest untouched -> evicted
    expect(map.has('session-new')).toBe(true);
  });

  test('stop -> get keeps working (collectors are not deleted on stop)', () => {
    const map = new Map<string, BufferedEventCollector<Entry>>();
    const collector = getOrCreateSessionCollector(map, 'session-a');
    collector.start();
    collector.push({ timestamp: Date.now(), message: 'hello' });
    collector.stop();

    const again = getOrCreateSessionCollector(map, 'session-a');
    expect(again).toBe(collector);
    expect(again.get()).toHaveLength(1);
  });
});

describe('monitor timers are unref()d', () => {
  test('SimulatorCrashWatcher interval does not hold the event loop', () => {
    const pool = new SimulatorPool({ max: 1 });
    const watcher = new SimulatorCrashWatcher(pool);
    watcher.start(10_000);
    const interval = (watcher as unknown as { interval: NodeJS.Timeout }).interval;
    expect(interval.hasRef()).toBe(false);
    watcher.stop();
  });

  test('SimulatorMonitor interval does not hold the event loop', () => {
    const monitor = new SimulatorMonitor();
    monitor.start();
    const interval = (monitor as unknown as { interval: NodeJS.Timeout }).interval;
    expect(interval.hasRef()).toBe(false);
    monitor.stop();
  });

  test('SimulatorPool idle and resource monitor intervals do not hold the event loop', () => {
    const pool = new SimulatorPool({ max: 1 });
    pool.startIdleMonitor();
    pool.startResourceMonitor();
    const idle = (pool as unknown as { idleCheckInterval: NodeJS.Timeout }).idleCheckInterval;
    const resource = (pool as unknown as { resourceCheckInterval: NodeJS.Timeout }).resourceCheckInterval;
    expect(idle.hasRef()).toBe(false);
    expect(resource.hasRef()).toBe(false);
    pool.stopIdleMonitor();
    pool.stopResourceMonitor();
  });
});
