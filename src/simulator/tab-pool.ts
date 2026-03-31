/**
 * TabPool — Manages multiple Safari tabs within a single simulator.
 *
 * Opens tabs via `simctl openurl`, discovers new targets via ios-webkit-debug-proxy's
 * /json endpoint, and creates TabClient wrappers for independent per-tab control.
 * This enables lightweight parallelism (~15-50MB per tab vs ~2GB per simulator).
 */

import { EventEmitter } from 'events';
import { SimulatorManager } from './manager';
import { WebKitClient, WebKitTarget } from '../webkit/client';
import { TabClient } from './tab-client';

export interface TabInfo {
  targetId: string;
  url: string;
  client: TabClient;
  createdAt: number;
}

export interface TabPoolOptions {
  /** Maximum tabs per simulator (default: 10) */
  maxTabs?: number;
  /** Time to wait for new target to appear after openurl (default: 5000ms) */
  targetDiscoveryTimeout?: number;
}

export class TabPool extends EventEmitter {
  private tabs: Map<string, TabInfo> = new Map();
  private manager: SimulatorManager;
  private maxTabs: number;
  private discoveryTimeout: number;

  constructor(
    private client: WebKitClient,
    private deviceId: string,
    options?: TabPoolOptions,
  ) {
    super();
    this.manager = new SimulatorManager();
    this.maxTabs = options?.maxTabs ?? 10;
    this.discoveryTimeout = options?.targetDiscoveryTimeout ?? 5000;

    // Track target destruction
    this.client.on('target:destroyed', (event: { targetId: string }) => {
      if (this.tabs.has(event.targetId)) {
        this.tabs.delete(event.targetId);
        this.emit('tab:closed', { targetId: event.targetId });
      }
    });
  }

  /**
   * Open a new Safari tab by navigating to a URL.
   * Returns a TabClient for independent control of the new tab.
   */
  async openTab(url: string): Promise<TabClient> {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error(`Tab limit reached (${this.maxTabs}). Close tabs before opening new ones.`);
    }

    // Snapshot current targets before opening new tab
    const beforeTargets = await this.client.listTargets();
    const beforeIds = new Set(beforeTargets.map(t => t.id));

    // Open URL — creates a new Safari tab
    await this.manager.openUrl(this.deviceId, url);

    // Wait for new target to appear
    const newTarget = await this.waitForNewTarget(beforeIds);

    const tabClient = new TabClient(this.client, newTarget.id);
    this.tabs.set(newTarget.id, {
      targetId: newTarget.id,
      url,
      client: tabClient,
      createdAt: Date.now(),
    });

    this.emit('tab:opened', { targetId: newTarget.id, url });
    return tabClient;
  }

  /**
   * Get a TabClient for the current active (first) tab.
   * Useful when a tab already exists from the initial boot.
   */
  async getDefaultTab(): Promise<TabClient> {
    const targets = await this.client.listTargets();
    const pageTarget = targets.find(t => t.type === 'page' || !t.type);
    if (!pageTarget) {
      throw new Error('No Safari tab found. Is Safari open?');
    }

    if (this.tabs.has(pageTarget.id)) {
      return this.tabs.get(pageTarget.id)!.client;
    }

    const tabClient = new TabClient(this.client, pageTarget.id);
    this.tabs.set(pageTarget.id, {
      targetId: pageTarget.id,
      url: pageTarget.url,
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

    try {
      // Close tab by navigating to about:blank then closing via JavaScript
      await tab.client.evaluate('window.close()');
    } catch {
      // Tab may already be gone
    }

    this.tabs.delete(targetId);
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
  }

  /**
   * Discover all existing Safari tabs and wrap them as TabClients.
   */
  async discoverExistingTabs(): Promise<TabClient[]> {
    const targets = await this.client.listTargets();
    const clients: TabClient[] = [];

    for (const target of targets) {
      if (this.tabs.has(target.id)) {
        clients.push(this.tabs.get(target.id)!.client);
        continue;
      }

      const tabClient = new TabClient(this.client, target.id);
      this.tabs.set(target.id, {
        targetId: target.id,
        url: target.url,
        client: tabClient,
        createdAt: Date.now(),
      });
      clients.push(tabClient);
    }

    return clients;
  }

  private async waitForNewTarget(beforeIds: Set<string>): Promise<WebKitTarget> {
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
