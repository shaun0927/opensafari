/**
 * TabPool Stress Tests — Validates multi-tab operations under load.
 *
 * Tests tab saturation, rapid open/close cycles, and concurrent operations.
 * Uses mocks for the WebKit layer to keep tests fast and CI-friendly.
 */

import { EventEmitter } from 'events';

// ── Mocks must be set up before importing modules that use them ──

let mockTargetCounter = 0;
let currentMockParentClient: any = null;

/**
 * Mock WebKitClient — each instance tracks its own activeTargetId
 * and delegates listTargets to the parent mock client.
 */
jest.mock('../../src/webkit/client', () => {
  return {
    WebKitClient: jest.fn().mockImplementation(() => {
      const targetId = `target-${++mockTargetCounter}`;
      const knownTargets = new Set([targetId]);
      const instance = Object.assign(new EventEmitter(), {
        connect: jest.fn().mockResolvedValue(undefined),
        connectToUrl: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockImplementation(async function (this: any) {
          // no-op mock
        }),
        isConnected: jest.fn().mockReturnValue(true),
        getHost: jest.fn().mockReturnValue('localhost'),
        getPort: jest.fn().mockReturnValue(9222),
        getActiveTargetId: jest.fn().mockReturnValue(targetId),
        getKnownTargets: jest.fn().mockReturnValue(knownTargets),
        listTargets: jest.fn().mockImplementation(async () => {
          // Delegate to the parent mock if available
          if (currentMockParentClient) {
            return currentMockParentClient.listTargets();
          }
          return [{ id: targetId, url: 'https://example.com', webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${targetId}` }];
        }),
        sendToTarget: jest.fn().mockImplementation(async (method: string) => {
          if (method === 'Runtime.evaluate') {
            return { result: { value: 'mock-result' }, wasThrown: false };
          }
          if (method === 'Page.snapshotRect') {
            const buf = Buffer.alloc(2048);
            buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
            return { dataURL: `data:image/png;base64,${buf.toString('base64')}` };
          }
          return {};
        }),
        enableDomainForTarget: jest.fn().mockResolvedValue(undefined),
      });
      return instance;
    }),
  };
});

jest.mock('../../src/simulator/manager', () => {
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      openUrl: jest.fn().mockImplementation(async (_udid: string, url: string) => {
        if (currentMockParentClient) {
          currentMockParentClient.addTarget(url);
        }
      }),
      boot: jest.fn(),
      shutdown: jest.fn(),
    })),
  };
});

// Import after mocks are set up
import { TabPool } from '../../src/simulator/tab-pool';
import { TabClient } from '../../src/simulator/tab-client';

// ── Parent Mock Client ──
// The TabPool constructor receives a "parent" WebKitClient.
// We build a more capable mock for it that can track targets.

interface MockTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function createParentMockClient() {
  const targets: MockTarget[] = [];
  const defaultId = `target-default-${++mockTargetCounter}`;
  const knownTargets = new Set([defaultId]);
  targets.push({
    id: defaultId,
    url: 'https://example.com',
    webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${defaultId}`,
  });

  const client = Object.assign(new EventEmitter(), {
    isConnected: () => true,
    getHost: () => 'localhost',
    getPort: () => 9222,
    getActiveTargetId: () => defaultId,
    getKnownTargets: () => knownTargets,
    listTargets: async () => [...targets],
    connect: async () => {},
    disconnect: async () => {},
    connectToUrl: async () => {},
    sendToTarget: async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: 'mock-result' }, wasThrown: false };
      }
      return {};
    },
    enableDomainForTarget: async () => {},
    addTarget: (url: string): MockTarget => {
      const id = `target-${++mockTargetCounter}`;
      const target: MockTarget = { id, url, webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${id}` };
      targets.push(target);
      knownTargets.add(id);
      return target;
    },
    removeTarget: (id: string) => {
      const idx = targets.findIndex(t => t.id === id);
      if (idx >= 0) targets.splice(idx, 1);
      knownTargets.delete(id);
    },
  });

  return client;
}

// ── Test Suite ──

describe('TabPool Stress Tests', () => {
  let client: ReturnType<typeof createParentMockClient>;
  let tabPool: TabPool;
  const DEVICE_UDID = 'mock-device-0000-1111-2222';

  beforeEach(() => {
    mockTargetCounter = 0;
    client = createParentMockClient();
    currentMockParentClient = client;
    tabPool = new TabPool(client as any, DEVICE_UDID, {
      maxTabs: 10,
      targetDiscoveryTimeout: 3000,
    });
  });

  afterEach(async () => {
    try { await tabPool.closeAll(); } catch { /* best-effort */ }
    currentMockParentClient = null;
  });

  // ── Test 1: Tab Saturation ──

  test('should open maximum tabs (10) with independent connections', async () => {
    const defaultTab = await tabPool.getDefaultTab();
    expect(defaultTab).toBeInstanceOf(TabClient);

    const tabs: TabClient[] = [defaultTab];
    for (let i = 0; i < 9; i++) {
      const tab = await tabPool.openTab(`https://example.com/page-${i}`);
      expect(tab).toBeInstanceOf(TabClient);
      tabs.push(tab);
    }

    expect(tabPool.size).toBe(10);

    const targetIds = tabs.map(t => t.getTargetId());
    const uniqueIds = new Set(targetIds);
    expect(uniqueIds.size).toBe(10);

    for (const tab of tabs) {
      expect(tab.isConnected()).toBe(true);
    }
  }, 30_000);

  // ── Test 2: Exceed Max Tabs ──

  test('should throw clean error when exceeding maxTabs limit', async () => {
    await tabPool.getDefaultTab();
    for (let i = 0; i < 9; i++) {
      await tabPool.openTab(`https://example.com/page-${i}`);
    }
    expect(tabPool.size).toBe(10);

    await expect(tabPool.openTab('https://example.com/overflow')).rejects.toThrow(
      /Tab limit reached/
    );

    expect(tabPool.size).toBe(10);
  }, 30_000);

  // ── Test 3: Rapid Open/Close Cycles ──

  test('should handle 20 rapid open/close cycles without resource leaks', async () => {
    const openedIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const tab = await tabPool.openTab(`https://example.com/rapid-${i}`);
      const targetId = tab.getTargetId();
      openedIds.push(targetId);

      await tabPool.closeTab(targetId);
      expect(tabPool.getTab(targetId)).toBeNull();
    }

    expect(tabPool.size).toBe(0);

    const uniqueIds = new Set(openedIds);
    expect(uniqueIds.size).toBe(20);
  }, 30_000);

  // ── Test 4: Concurrent Evaluation Across Tabs ──

  test('should run evaluate() on multiple tabs simultaneously via Promise.all', async () => {
    const tabs: TabClient[] = [];
    await tabPool.getDefaultTab().then(t => tabs.push(t));
    for (let i = 0; i < 4; i++) {
      const tab = await tabPool.openTab(`https://example.com/concurrent-${i}`);
      tabs.push(tab);
    }
    expect(tabs.length).toBe(5);

    const start = Date.now();
    const results = await Promise.all(
      tabs.map(tab => tab.evaluate<string>('document.title'))
    );
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result).toBeDefined();
    }

    expect(elapsed).toBeLessThan(2000);
  }, 30_000);

  // ── Test 5: Tab Close During Operation ──

  test('should handle tab close during a pending evaluate gracefully', async () => {
    const tab = await tabPool.openTab('https://example.com/close-mid-op');
    const targetId = tab.getTargetId();

    const evalPromise = tab.evaluate<string>('document.title').catch(() => 'eval-failed');
    const closePromise = tabPool.closeTab(targetId);

    const [evalResult] = await Promise.all([evalPromise, closePromise]);

    expect(typeof evalResult).toBe('string');
    expect(tabPool.getTab(targetId)).toBeNull();
  }, 30_000);

  // ── Test 6: Open/Close Interleaving ──

  test('should maintain correct pool size during interleaved open/close operations', async () => {
    const tabs: Array<{ id: string; tab: TabClient }> = [];
    for (let i = 0; i < 5; i++) {
      const tab = await tabPool.openTab(`https://example.com/interleave-${i}`);
      tabs.push({ id: tab.getTargetId(), tab });
    }
    expect(tabPool.size).toBe(5);

    for (let i = 1; i < 5; i += 2) {
      await tabPool.closeTab(tabs[i].id);
    }
    expect(tabPool.size).toBe(3);

    for (let i = 0; i < 4; i++) {
      await tabPool.openTab(`https://example.com/refill-${i}`);
    }
    expect(tabPool.size).toBe(7);

    await tabPool.closeAll();
    expect(tabPool.size).toBe(0);
  }, 30_000);

  // ── Test 7: listTabs Consistency ──

  test('should return consistent tab list after multiple operations', async () => {
    await tabPool.getDefaultTab();
    for (let i = 0; i < 4; i++) {
      await tabPool.openTab(`https://example.com/list-${i}`);
    }

    const tabs = tabPool.listTabs();
    expect(tabs).toHaveLength(5);

    for (const info of tabs) {
      expect(info.targetId).toBeTruthy();
      expect(info.client).toBeInstanceOf(TabClient);
      expect(info.createdAt).toBeGreaterThan(0);
    }

    await tabPool.closeTab(tabs[1].targetId);
    await tabPool.closeTab(tabs[3].targetId);

    const remaining = tabPool.listTabs();
    expect(remaining).toHaveLength(3);

    const remainingIds = remaining.map(t => t.targetId);
    expect(remainingIds).not.toContain(tabs[1].targetId);
    expect(remainingIds).not.toContain(tabs[3].targetId);
  }, 30_000);

  // ── Test 8: Event Emission ──

  test('should emit tab:opened and tab:closed events correctly under load', async () => {
    const openedEvents: string[] = [];
    const closedEvents: string[] = [];

    tabPool.on('tab:opened', (event: { targetId: string }) => {
      openedEvents.push(event.targetId);
    });
    tabPool.on('tab:closed', (event: { targetId: string }) => {
      closedEvents.push(event.targetId);
    });

    const tabs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tab = await tabPool.openTab(`https://example.com/events-${i}`);
      tabs.push(tab.getTargetId());
    }

    expect(openedEvents).toHaveLength(5);

    for (const id of tabs) {
      await tabPool.closeTab(id);
    }

    expect(closedEvents).toHaveLength(5);

    for (const id of tabs) {
      expect(openedEvents).toContain(id);
      expect(closedEvents).toContain(id);
    }
  }, 30_000);
});
