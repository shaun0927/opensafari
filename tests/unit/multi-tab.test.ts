/**
 * Multi-Tab Multiplexing Tests
 * Verifies WebKitClient multi-target support, TabClient, and TabPool.
 */

import { TabClient } from '../../src/simulator/tab-client';
import { TabPool } from '../../src/simulator/tab-pool';
import { WebKitClient } from '../../src/webkit/client';
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

  async enableDomainForTarget(domain: string, targetId: string): Promise<void> {
    this._sentMessages.push({ method: `${domain}.enable`, targetId });
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

  getSentMessages() { return this._sentMessages; }
  clearSentMessages() { this._sentMessages = []; }
}

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

    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    const clients = await pool.discoverExistingTabs();
    expect(clients).toHaveLength(3);
    expect(pool.size).toBe(3);
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

  it('should remove tab when target is destroyed externally', async () => {
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.getDefaultTab();
    expect(pool.size).toBe(1);

    mockClient.emit('target:destroyed', { targetId: 'initial-tab' });
    expect(pool.size).toBe(0);
  });

  it('should close all tabs', async () => {
    mockClient.addTarget('tab-2');
    const pool = new TabPool(mockClient as unknown as WebKitClient, 'test-udid');
    await pool.discoverExistingTabs();
    expect(pool.size).toBe(2);

    await pool.closeAll();
    expect(pool.size).toBe(0);
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
});
