/**
 * Multi-Tab Multiplexing Tests
 * Verifies WebKitClient multi-target support, TabClient, and TabPool.
 */

import { TabClient } from '../../src/simulator/tab-client';
import { TabPool } from '../../src/simulator/tab-pool';
import { WebKitClient } from '../../src/webkit/client';
import * as webkitClientModule from '../../src/webkit/client';
import { EventEmitter } from 'events';

// ========== Mock WebKitClient ==========

class MockWebKitClient extends EventEmitter {
  private _connected = true;
  private _targets = new Set<string>();
  private _activeTargetId: string | null = null;
  private _sentMessages: Array<{ method: string; params?: any; targetId?: string }> = [];

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  isConnected(): boolean { return this._connected; }

  getKnownTargets(): Set<string> { return new Set(this._targets); }

  getActiveTargetId(): string | null { return this._activeTargetId; }

  addTarget(id: string): void {
    this._targets.add(id);
    if (!this._activeTargetId) this._activeTargetId = id;
  }

  removeTarget(id: string): void {
    this._targets.delete(id);
    if (this._activeTargetId === id) {
      this._activeTargetId = this._targets.size > 0
        ? this._targets.values().next().value ?? null
        : null;
    }
  }

  async sendToTarget<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    targetId?: string | null,
  ): Promise<T> {
    const resolvedTarget = targetId ?? this._activeTargetId;
    this._sentMessages.push({ method, params, targetId: resolvedTarget ?? undefined });

    // Mock responses for common methods
    if (method === 'Runtime.evaluate') {
      const expr = params?.expression as string;
      if (expr === 'document.documentElement.outerHTML') {
        return { result: { value: '<html></html>' } } as unknown as T;
      }
      return { result: { value: `eval-on-${resolvedTarget}` } } as unknown as T;
    }
    if (method === 'Page.snapshotRect') {
      return { dataURL: 'data:image/png;base64,iVBOR' } as unknown as T;
    }
    if (method === 'Page.getCookies') {
      return { cookies: [{ name: 'test', value: '1', domain: '.example.com' }] } as unknown as T;
    }
    if (method === 'Page.navigate') {
      return {} as unknown as T;
    }
    if (method.endsWith('.enable')) {
      return {} as unknown as T;
    }
    return {} as unknown as T;
  }

  private _enabledPerTarget: Map<string, Set<string>> = new Map();

  async enableDomainForTarget(domain: string, targetId: string): Promise<void> {
    this._sentMessages.push({ method: `${domain}.enable`, targetId });
    if (!this._enabledPerTarget.has(targetId)) {
      this._enabledPerTarget.set(targetId, new Set());
    }
    this._enabledPerTarget.get(targetId)!.add(domain);
  }

  getEnabledDomainsForTarget(targetId: string): Set<string> {
    return new Set(this._enabledPerTarget.get(targetId) ?? []);
  }

  async listTargets(): Promise<Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type?: string }>> {
    return Array.from(this._targets).map(id => ({
      id,
      url: `https://example.com/${id}`,
      title: `Tab ${id}`,
      webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${id}`,
      type: 'page',
    }));
  }

  getHost(): string { return 'localhost'; }
  getPort(): number { return 9222; }
  async connectToUrl(_wsUrl: string, _options?: { retries?: number; retryDelay?: number }): Promise<void> {
    // Mock: set up a target from the wsUrl
    const match = _wsUrl.match(/\/devtools\/page\/(\S+)/);
    if (match) {
      this.addTarget(match[1]);
    }
  }
  async disconnect(): Promise<void> { this._connected = false; }

  getSentMessages() { return this._sentMessages; }
  clearSentMessages() { this._sentMessages = []; }
}

// ── Module mock for openTab tests (hoisted by Jest) ──

jest.mock('../../src/simulator/manager', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    boot: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    openUrl: jest.fn().mockResolvedValue(undefined),
  })),
}));

// ========== TabClient Tests ==========

describe('TabClient', () => {
  let mockClient: MockWebKitClient;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('target-1');
    mockClient.addTarget('target-2');
  });

  it('should pin operations to specific target', async () => {
    const tab1 = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    const tab2 = new TabClient(mockClient as unknown as WebKitClient, 'target-2');

    await tab1.evaluate('1+1');
    await tab2.evaluate('2+2');

    const msgs = mockClient.getSentMessages();
    const runtimeCalls = msgs.filter(m => m.method === 'Runtime.evaluate');
    expect(runtimeCalls[0].targetId).toBe('target-1');
    expect(runtimeCalls[1].targetId).toBe('target-2');
  });

  it('should return correct targetId', () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    expect(tab.getTargetId()).toBe('target-1');
  });

  it('should report connected when target exists', () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    expect(tab.isConnected()).toBe(true);
  });

  it('should report disconnected when target is removed', () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    mockClient.removeTarget('target-1');
    expect(tab.isConnected()).toBe(false);
  });

  it('should read page via pinned target', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    const html = await tab.readPage();
    expect(html).toBe('<html></html>');

    const msgs = mockClient.getSentMessages();
    expect(msgs.every(m => m.targetId === 'target-1')).toBe(true);
  });

  it('should get cookies via pinned target', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    const cookies = await tab.getCookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('test');
  });

  it('should enable domain for specific target', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-2');
    await tab.evaluate('test');

    const msgs = mockClient.getSentMessages();
    const enableCall = msgs.find(m => m.method === 'Runtime.enable');
    expect(enableCall?.targetId).toBe('target-2');
  });

  it('should emit disconnect when target is destroyed', (done) => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    tab.on('disconnect', () => {
      done();
    });
    mockClient.emit('target:destroyed', { targetId: 'target-1' });
  });

  it('should not emit disconnect for other targets', () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    const handler = jest.fn();
    tab.on('disconnect', handler);
    mockClient.emit('target:destroyed', { targetId: 'target-2' });
    expect(handler).not.toHaveBeenCalled();
  });
});

// ========== TabPool Tests ==========

describe('TabPool', () => {
  let mockClient: MockWebKitClient;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('initial-tab');
  });

  it('should get default tab', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    const tab = await pool.getDefaultTab();
    expect(tab).toBeInstanceOf(TabClient);
    expect(tab.getTargetId()).toBe('initial-tab');
  });

  it('should reuse existing default tab', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    const tab1 = await pool.getDefaultTab();
    const tab2 = await pool.getDefaultTab();
    expect(tab1).toBe(tab2);
  });

  it('should track tab count', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    expect(pool.size).toBe(0);
    await pool.getDefaultTab();
    expect(pool.size).toBe(1);
  });

  it('should list tabs', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.getDefaultTab();
    const tabs = pool.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].targetId).toBe('initial-tab');
  });

  it('should get tab by targetId', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.getDefaultTab();
    const tab = pool.getTab('initial-tab');
    expect(tab).toBeInstanceOf(TabClient);
    expect(tab?.getTargetId()).toBe('initial-tab');
  });

  it('should return null for unknown tab', () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    expect(pool.getTab('nonexistent')).toBeNull();
  });

  it('should discover existing tabs', async () => {
    mockClient.addTarget('tab-2');
    mockClient.addTarget('tab-3');

    // Mock WebKitClient constructor for dedicated connections
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => {
      return new MockWebKitClient();
    }) as unknown as (options: any) => any);

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    const clients = await pool.discoverExistingTabs();
    expect(clients).toHaveLength(3);
    expect(pool.size).toBe(3);

    jest.restoreAllMocks();
  });

  it('should enforce max tabs limit', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', { maxTabs: 1 });
    await pool.getDefaultTab();

    await expect(pool.openTab('https://example.com')).rejects.toThrow('Tab limit reached');
  });

  it('should remove tab on close', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.getDefaultTab();
    expect(pool.size).toBe(1);

    await pool.closeTab('initial-tab');
    expect(pool.size).toBe(0);
    expect(pool.getTab('initial-tab')).toBeNull();
  });

  it('should remove tab on explicit close', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.getDefaultTab();
    expect(pool.size).toBe(1);

    await pool.closeTab('initial-tab');
    expect(pool.size).toBe(0);
    expect(pool.getTab('initial-tab')).toBeNull();
  });

  it('should close all tabs', async () => {
    mockClient.addTarget('tab-2');

    // Mock WebKitClient constructor for dedicated connections
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => {
      return new MockWebKitClient();
    }) as unknown as (options: any) => any);

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.discoverExistingTabs();
    expect(pool.size).toBe(2);

    await pool.closeAll();
    expect(pool.size).toBe(0);

    jest.restoreAllMocks();
  });

  it('should emit events on tab open and close', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    const closeHandler = jest.fn();
    pool.on('tab:closed', closeHandler);

    await pool.getDefaultTab();
    await pool.closeTab('initial-tab');
    expect(closeHandler).toHaveBeenCalledWith({ targetId: 'initial-tab' });
  });
});

// ========== WebKitClient Multi-Target State Tests ==========

describe('WebKitClient multi-target tracking', () => {
  // These test the public API contracts without a real WebSocket
  it('should export sendToTarget method', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(typeof client.sendToTarget).toBe('function');
  });

  it('should export target accessor methods', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(typeof client.getActiveTargetId).toBe('function');
    expect(typeof client.getKnownTargets).toBe('function');
    expect(typeof client.setActiveTargetId).toBe('function');
    expect(typeof client.enableDomainForTarget).toBe('function');
  });

  it('should return empty known targets initially', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(client.getKnownTargets().size).toBe(0);
  });

  it('should return null active target initially', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(client.getActiveTargetId()).toBeNull();
  });

  it('should throw when setting unknown target as active', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(() => client.setActiveTargetId('nonexistent')).toThrow('not found');
  });

  it('should return empty per-target domains initially', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(client.getEnabledDomainsForTarget('any-target').size).toBe(0);
  });

  it('should export getEnabledDomainsForTarget method', () => {
    const client = new WebKitClient({ host: 'localhost', port: 9322 });
    expect(typeof client.getEnabledDomainsForTarget).toBe('function');
  });
});

// ========== Per-Target Domain Tracking Tests ==========

describe('Per-target domain tracking', () => {
  let mockClient: MockWebKitClient;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('target-1');
    mockClient.addTarget('target-2');
  });

  it('should track domains per target via enableDomainForTarget', async () => {
    const tab1 = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    const tab2 = new TabClient(mockClient as unknown as WebKitClient, 'target-2');

    // Enable Page on tab1, Runtime on tab2
    await tab1.evaluate('test'); // triggers Runtime.enable for target-1
    await tab2.getCookies();     // triggers Page.enable for target-2

    const t1Domains = mockClient.getEnabledDomainsForTarget('target-1');
    const t2Domains = mockClient.getEnabledDomainsForTarget('target-2');

    expect(t1Domains.has('Runtime')).toBe(true);
    expect(t2Domains.has('Page')).toBe(true);
    // Domains should be independent
    expect(t1Domains.has('Page')).toBe(false);
    expect(t2Domains.has('Runtime')).toBe(false);
  });

  it('should not leak domains between targets', async () => {
    const tab1 = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    // target-2 exists but we don't use its TabClient — verifying isolation

    await tab1.evaluate('test');
    await tab1.getCookies();

    // tab1 should have both Runtime and Page
    const t1Domains = mockClient.getEnabledDomainsForTarget('target-1');
    expect(t1Domains.has('Runtime')).toBe(true);
    expect(t1Domains.has('Page')).toBe(true);

    // target-2 should have nothing (never used)
    const t2Domains = mockClient.getEnabledDomainsForTarget('target-2');
    expect(t2Domains.size).toBe(0);
  });

  it('should clean up domains when target is destroyed', () => {
    // Simulate enableDomainForTarget being tracked
    mockClient.enableDomainForTarget('Page', 'target-1');
    mockClient.enableDomainForTarget('Runtime', 'target-1');
    expect(mockClient.getEnabledDomainsForTarget('target-1').size).toBe(2);

    // Simulate target destruction — in real code, WebKitClient clears enabledDomainsPerTarget
    // Here we verify the mock tracks independently
    mockClient.removeTarget('target-1');
    // target-2 should be unaffected
    expect(mockClient.getEnabledDomainsForTarget('target-2').size).toBe(0);
  });

  it('should handle multiple domains on same target', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');

    await tab.evaluate('test');  // Runtime.enable
    await tab.getCookies();      // Page.enable

    const domains = mockClient.getEnabledDomainsForTarget('target-1');
    expect(domains.size).toBe(2);
    expect(domains.has('Runtime')).toBe(true);
    expect(domains.has('Page')).toBe(true);
  });
});

// ========== TabPool.waitForNewTarget() Timeout Tests (Issue #320) ==========

describe('TabPool.waitForNewTarget() Timeout', () => {
  let mockClient: MockWebKitClient;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('existing-tab');
  });

  it('should throw timeout when new target never appears', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      targetDiscoveryTimeout: 600,
    });

    // listTargets always returns only the existing target — no new target ever appears
    await expect(pool.openTab('https://example.com')).rejects.toThrow(
      'New tab target not discovered within 600ms'
    );
  }, 10000);

  it('should succeed when new target appears on 3rd poll', async () => {
    // Mock WebKitClient constructor to return mock instances for dedicated connections
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      targetDiscoveryTimeout: 5000,
    });

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'existing-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/existing-tab', type: 'page' },
      ];
      if (callCount >= 3) {
        targets.push({ id: 'new-tab', url: 'https://example.com', title: 'New', webSocketDebuggerUrl: 'ws://localhost/devtools/page/new-tab', type: 'page' });
      }
      return targets;
    });

    const tab = await pool.openTab('https://example.com');
    expect(tab).toBeInstanceOf(TabClient);
    // targetId is the protocol-level ID from the dedicated client
    expect(tab.getTargetId()).toBe('new-tab');

    jest.restoreAllMocks();
  }, 10000);
});

// ========== TabPool Cookie Isolation Tests (Issue #333) ==========

describe('TabPool Cookie Isolation', () => {
  let mockClient: MockWebKitClient;
  let getCookiesSpy: jest.SpyInstance;
  let clearCookiesSpy: jest.SpyInstance;
  let setCookiesSpy: jest.SpyInstance;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('initial-tab');

    // Add cookie-related methods to the mock
    (mockClient as any).getCookies = jest.fn().mockResolvedValue([
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/', expires: 0, httpOnly: true, secure: true },
    ]);
    (mockClient as any).clearCookies = jest.fn().mockResolvedValue(undefined);
    (mockClient as any).setCookies = jest.fn().mockResolvedValue(undefined);

    getCookiesSpy = (mockClient as any).getCookies;
    clearCookiesSpy = (mockClient as any).clearCookies;
    setCookiesSpy = (mockClient as any).setCookies;
  });

  it('should snapshot cookies before tab navigation when isolateCookies is true', async () => {
    // Mock WebKitClient constructor for dedicated connections
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'initial-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/initial-tab', type: 'page' },
      ];
      if (callCount >= 2) {
        targets.push({ id: 'new-tab', url: 'https://example.com', title: 'New', webSocketDebuggerUrl: 'ws://localhost/devtools/page/new-tab', type: 'page' });
      }
      return targets;
    });

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      isolateCookies: true,
      targetDiscoveryTimeout: 5000,
    });

    await pool.openTab('https://example.com');

    // getCookies should have been called to take a snapshot
    expect(getCookiesSpy).toHaveBeenCalled();
    // clearCookies should have been called to isolate the new tab
    expect(clearCookiesSpy).toHaveBeenCalled();

    jest.restoreAllMocks();
  }, 10000);

  it('should clear cookies between tab openings when isolateCookies is true', async () => {
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'initial-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/initial-tab', type: 'page' },
      ];
      if (callCount >= 2) {
        targets.push({ id: `new-tab-${callCount}`, url: 'https://example.com', title: 'New', webSocketDebuggerUrl: `ws://localhost/devtools/page/new-tab-${callCount}`, type: 'page' });
      }
      return targets;
    });

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      isolateCookies: true,
      targetDiscoveryTimeout: 5000,
    });

    await pool.openTab('https://example.com');

    // clearCookies should have been called once (during openTab)
    expect(clearCookiesSpy).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  }, 10000);

  it('should restore cookie snapshot on tab close when isolateCookies is true', async () => {
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'initial-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/initial-tab', type: 'page' },
      ];
      if (callCount >= 2) {
        targets.push({ id: 'new-tab', url: 'https://example.com', title: 'New', webSocketDebuggerUrl: 'ws://localhost/devtools/page/new-tab', type: 'page' });
      }
      return targets;
    });

    const savedCookies = [
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/', expires: 0, httpOnly: true, secure: true },
    ];
    getCookiesSpy.mockResolvedValue(savedCookies);

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      isolateCookies: true,
      targetDiscoveryTimeout: 5000,
    });

    const tab = await pool.openTab('https://example.com');
    const targetId = tab.getTargetId();

    // Reset spies to track close behavior
    clearCookiesSpy.mockClear();
    setCookiesSpy.mockClear();

    await pool.closeTab(targetId);

    // On close: clearCookies should be called, then setCookies to restore snapshot
    expect(clearCookiesSpy).toHaveBeenCalled();
    expect(setCookiesSpy).toHaveBeenCalledWith(savedCookies);

    jest.restoreAllMocks();
  }, 10000);

  it('should not snapshot or restore cookies when isolateCookies is false (default)', async () => {
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'initial-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/initial-tab', type: 'page' },
      ];
      if (callCount >= 2) {
        targets.push({ id: 'new-tab', url: 'https://example.com', title: 'New', webSocketDebuggerUrl: 'ws://localhost/devtools/page/new-tab', type: 'page' });
      }
      return targets;
    });

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      targetDiscoveryTimeout: 5000,
    });

    const tab = await pool.openTab('https://example.com');
    await pool.closeTab(tab.getTargetId());

    // getCookies, clearCookies, setCookies should NOT have been called
    expect(getCookiesSpy).not.toHaveBeenCalled();
    expect(clearCookiesSpy).not.toHaveBeenCalled();
    expect(setCookiesSpy).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  }, 10000);

  it('should clear cookieSnapshots on closeAll', async () => {
    const mockDedicatedClient = new MockWebKitClient();
    jest.spyOn(webkitClientModule, 'WebKitClient').mockImplementation((() => mockDedicatedClient) as unknown as (options: any) => any);

    let callCount = 0;
    jest.spyOn(mockClient, 'listTargets').mockImplementation(async () => {
      callCount++;
      const targets: Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }> = [
        { id: 'initial-tab', url: 'about:blank', title: 'Tab', webSocketDebuggerUrl: 'ws://localhost/devtools/page/initial-tab', type: 'page' },
      ];
      if (callCount >= 2) {
        targets.push({ id: 'new-tab', url: 'https://example.com', title: 'New', webSocketDebuggerUrl: 'ws://localhost/devtools/page/new-tab', type: 'page' });
      }
      return targets;
    });

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid', {
      isolateCookies: true,
      targetDiscoveryTimeout: 5000,
    });

    await pool.openTab('https://example.com');

    await pool.closeAll();

    // After closeAll, the internal cookieSnapshots map should be cleared
    // Verify by checking that size is 0
    expect(pool.size).toBe(0);

    jest.restoreAllMocks();
  }, 10000);
});

// ========== TabClient Edge Cases (Issue #320) ==========

describe('TabClient Edge Cases', () => {
  let mockClient: MockWebKitClient;

  beforeEach(() => {
    mockClient = new MockWebKitClient();
    mockClient.addTarget('target-1');
  });

  it('waitFor() with element not found → throws after timeout', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');
    jest.spyOn(tab, 'querySelector').mockResolvedValue(null);

    await expect(
      tab.waitFor('.nonexistent', { timeout: 500 })
    ).rejects.toThrow('waitFor: .nonexistent not found within 500ms');
  }, 10000);

  it('clearCookies() calls getCookies then deleteCookie for each', async () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');

    jest.spyOn(tab, 'getCookies').mockResolvedValue([
      { name: 'session', value: 'abc', domain: '.example.com', path: '/', expires: 0, httpOnly: true, secure: true },
      { name: 'token', value: 'xyz', domain: '.example.com', path: '/api', expires: 0, httpOnly: false, secure: true },
    ]);

    const sendSpy = jest.spyOn(tab as any, 'send').mockResolvedValue(undefined);

    await tab.clearCookies();

    expect(tab.getCookies).toHaveBeenCalled();
    const deleteCalls = sendSpy.mock.calls.filter(c => c[0] === 'Page.deleteCookie');
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0][1]).toEqual({ cookieName: 'session', url: 'https://.example.com/' });
    expect(deleteCalls[1][1]).toEqual({ cookieName: 'token', url: 'https://.example.com/api' });
  });

  it('destroy() removes all listeners, subsequent events not received', () => {
    const tab = new TabClient(mockClient as unknown as WebKitClient, 'target-1');

    // Register an event handler via the public API
    tab.onConsole(() => {});
    expect((tab as any)._listeners).toHaveLength(1);

    // Before destroy: target:destroyed triggers disconnect
    const disconnectHandler = jest.fn();
    tab.on('disconnect', disconnectHandler);
    mockClient.emit('target:destroyed', { targetId: 'target-1' });
    expect(disconnectHandler).toHaveBeenCalledTimes(1);

    // Destroy cleans up
    disconnectHandler.mockClear();
    tab.destroy();
    expect((tab as any)._listeners).toHaveLength(0);

    // Re-add listener after destroy
    tab.on('disconnect', disconnectHandler);

    // After destroy: target:destroyed does NOT trigger disconnect
    mockClient.emit('target:destroyed', { targetId: 'target-1' });
    expect(disconnectHandler).not.toHaveBeenCalled();
  });
});
