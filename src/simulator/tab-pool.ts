/**
 * TabPool — Manages multiple Safari tabs within a single simulator.
 *
 * Opens tabs via `simctl openurl`, discovers new targets via ios-webkit-debug-proxy's
 * /json endpoint, and creates dedicated per-tab WebKitClient connections.
 * Each tab gets its own WebSocket connection to its specific /devtools/page/N endpoint,
 * since ios-webkit-debug-proxy does not emit Target.targetCreated events for new tabs.
 */

import { EventEmitter } from 'events';
import { SimulatorManager } from './manager';
import { WebKitClient } from '../webkit/client';
import { TabClient } from './tab-client';
import { Cookie } from '../types/browser-backend';

export interface TabInfo {
  targetId: string;
  url: string;
  client: TabClient;
  dedicatedClient?: WebKitClient;
  createdAt: number;
}

export interface TabPoolOptions {
  /** Maximum tabs per simulator (default: 10) */
  maxTabs?: number;
  /** Time to wait for new target to appear after openurl (default: 5000ms) */
  targetDiscoveryTimeout?: number;
  /** When true, snapshot and restore cookies per tab to prevent cross-tab contamination (default: false) */
  isolateCookies?: boolean;
}

export class TabPool extends EventEmitter {
  private tabs: Map<string, TabInfo> = new Map();
  private manager: SimulatorManager;
  private maxTabs: number;
  private discoveryTimeout: number;
  private cookieSnapshots: Map<string, Cookie[]> = new Map();
  private isolateCookies: boolean;

  constructor(
    private client: WebKitClient,
    private deviceId: string,
    options?: TabPoolOptions,
  ) {
    super();
    this.manager = new SimulatorManager();
    this.maxTabs = options?.maxTabs ?? 10;
    this.discoveryTimeout = options?.targetDiscoveryTimeout ?? 5000;
    this.isolateCookies = options?.isolateCookies ?? false;
  }

  /**
   * Open a new Safari tab by navigating to a URL.
   * Creates a dedicated WebKitClient connection for the new tab.
   */
  async openTab(url: string): Promise<TabClient> {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error(`Tab limit reached (${this.maxTabs}). Close tabs before opening new ones.`);
    }

    // Cookie isolation: snapshot current cookies and clear before opening new tab
    if (this.isolateCookies) {
      const currentCookies = await this.client.getCookies();
      // Store snapshot keyed by a temporary ID; will be re-keyed to the target ID below
      this.cookieSnapshots.set(`_pending_${Date.now()}`, currentCookies);
      await this.client.clearCookies();
    }

    // Snapshot current /json targets before opening new tab
    const beforeTargets = await this.client.listTargets();
    const beforeIds = new Set(beforeTargets.map(t => t.id));

    // Add unique fragment to prevent Safari from reusing an existing tab with the same URL.
    // Fragments are not sent to the server, so this doesn't change the actual request.
    const uniqueUrl = url + (url.includes('#') ? '' : `#_ostab${Date.now()}`);

    // Open URL — creates a new Safari tab
    await this.manager.openUrl(this.deviceId, uniqueUrl);

    // Poll /json for the new target
    const newTarget = await this.waitForNewTarget(beforeIds);

    // Create a dedicated WebKitClient for this specific tab
    const dedicatedClient = new WebKitClient({
      host: this.client.getHost(),
      port: this.client.getPort(),
    });
    await dedicatedClient.connectToUrl(newTarget.webSocketDebuggerUrl, { retries: 3, retryDelay: 1000 });

    // Get the protocol-level target ID from the dedicated connection
    const protocolTargetId = dedicatedClient.getActiveTargetId();
    if (!protocolTargetId) {
      await dedicatedClient.disconnect();
      throw new Error('Failed to obtain protocol target ID for new tab');
    }

    const tabClient = new TabClient(dedicatedClient, protocolTargetId);
    this.tabs.set(protocolTargetId, {
      targetId: protocolTargetId,
      url,
      client: tabClient,
      dedicatedClient,
      createdAt: Date.now(),
    });

    // Cookie isolation: re-key the pending snapshot to the actual target ID
    if (this.isolateCookies) {
      const pendingKey = Array.from(this.cookieSnapshots.keys()).find(k => k.startsWith('_pending_'));
      if (pendingKey) {
        const snapshot = this.cookieSnapshots.get(pendingKey)!;
        this.cookieSnapshots.delete(pendingKey);
        this.cookieSnapshots.set(protocolTargetId, snapshot);
      }
    }

    this.emit('tab:opened', { targetId: protocolTargetId, url });
    return tabClient;
  }

  /**
   * Get a TabClient for the current active (first) tab.
   * Uses the boot-time WebKitClient connection.
   */
  async getDefaultTab(): Promise<TabClient> {
    const activeId = this.client.getActiveTargetId();
    if (!activeId) {
      throw new Error('No Safari tab found. Is Safari open?');
    }

    if (this.tabs.has(activeId)) {
      return this.tabs.get(activeId)!.client;
    }

    const tabClient = new TabClient(this.client, activeId);
    this.tabs.set(activeId, {
      targetId: activeId,
      url: '',
      client: tabClient,
      createdAt: Date.now(),
    });

    return tabClient;
  }

  /**
   * Close a specific tab.
   */
  async closeTab(targetId: string): Promise<void> {
    const tab = this.tabs.get(targetId);
    if (!tab) return;

    this.tabs.delete(targetId);
    tab.client.destroy();

    try {
      await tab.client.evaluate('window.close()');
    } catch {
      // Tab may already be gone
    }

    // Disconnect dedicated per-tab connection
    if (tab.dedicatedClient) {
      try { await tab.dedicatedClient.disconnect(); } catch { /* ignore */ }
    }

    // Cookie isolation: restore cookies from snapshot after tab closes
    if (this.isolateCookies) {
      const snapshot = this.cookieSnapshots.get(targetId);
      if (snapshot) {
        try {
          await this.client.clearCookies();
          if (snapshot.length > 0) {
            await this.client.setCookies(snapshot);
          }
        } catch (err) {
          console.error(`[TabPool] Failed to restore cookie snapshot for ${targetId}: ${err}`);
        }
        this.cookieSnapshots.delete(targetId);
      }
    }

    this.emit('tab:closed', { targetId });
  }

  /**
   * List all managed tabs.
   */
  listTabs(): TabInfo[] {
    return Array.from(this.tabs.values());
  }

  /**
   * Get a specific tab's client.
   */
  getTab(targetId: string): TabClient | null {
    return this.tabs.get(targetId)?.client ?? null;
  }

  /**
   * Get count of open tabs.
   */
  get size(): number {
    return this.tabs.size;
  }

  /**
   * Close all tabs managed by this pool.
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.tabs.keys());
    for (const id of ids) {
      await this.closeTab(id);
    }
    this.cookieSnapshots.clear();
  }

  /**
   * Discover all existing Safari tabs and wrap them as TabClients.
   * Creates dedicated WebKitClient connections for each discovered tab.
   */
  async discoverExistingTabs(): Promise<TabClient[]> {
    const targets = await this.client.listTargets();
    const clients: TabClient[] = [];

    for (const target of targets) {
      // Check if already tracked by any means
      const existing = Array.from(this.tabs.values()).find(
        t => t.url === target.url || t.targetId === target.id
      );
      if (existing) {
        clients.push(existing.client);
        continue;
      }

      const dedicatedClient = new WebKitClient({
        host: this.client.getHost(),
        port: this.client.getPort(),
      });
      await dedicatedClient.connectToUrl(target.webSocketDebuggerUrl, { retries: 2, retryDelay: 500 });

      const protocolTargetId = dedicatedClient.getActiveTargetId();
      if (!protocolTargetId) {
        await dedicatedClient.disconnect();
        continue;
      }

      const tabClient = new TabClient(dedicatedClient, protocolTargetId);
      this.tabs.set(protocolTargetId, {
        targetId: protocolTargetId,
        url: target.url,
        client: tabClient,
        dedicatedClient,
        createdAt: Date.now(),
      });
      clients.push(tabClient);
    }

    return clients;
  }

  private async waitForNewTarget(beforeIds: Set<string>): Promise<{ id: string; webSocketDebuggerUrl: string; url: string }> {
    const start = Date.now();
    const pollInterval = 300;
    while (Date.now() - start < this.discoveryTimeout) {
      const currentTargets = await this.client.listTargets();
      const newTarget = currentTargets.find(t => !beforeIds.has(t.id));
      if (newTarget) return newTarget;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(
      `New tab target not discovered within ${this.discoveryTimeout}ms. ` +
      'Safari may not have opened the URL.'
    );
  }
}
