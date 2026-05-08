/**
 * TargetSessionManager — per-target session state for WebKit Remote Debugging Protocol.
 *
 * Extracted from client.ts (#706 3/5). Behavior-preserving; same target/active-target
 * semantics; per-target enabled-domain dedup preserved.
 *
 * Owns:
 *   - knownTargets Set
 *   - activeTargetId
 *   - per-target enabled-domain Sets
 *   - Target.targetCreated / Target.targetDestroyed event subscriptions
 *   - Re-enable logic for domains on new targets (delegated back via onNewTarget callback)
 *
 * Does NOT own: transport, WebSocket, message IDs, heartbeat, browser commands.
 */

import { EventEmitter } from 'events';
import { ConnectionError } from './errors';
import type { ProtocolTransport } from './protocol-transport';

// ========== Adapter interface ==========

/**
 * Minimal adapter interface used by TargetSessionManager to send protocol commands
 * back to the client without creating a circular dependency on WebKitClient.
 */
export interface TargetCommandSender {
  /**
   * Send a protocol command to a specific target.
   * Mirrors WebKitClient.sendToTarget signature (subset sufficient for domain re-enable).
   */
  sendToTarget<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    targetId?: string | null,
  ): Promise<T>;
}

// ========== TargetSessionManager ==========

export class TargetSessionManager extends EventEmitter {
  private activeTargetId: string | null = null;
  private readonly knownTargets: Set<string> = new Set();
  private readonly enabledDomainsPerTarget: Map<string, Set<string>> = new Map();

  // Global enabled-domain set (set by WebKitClient.enableDomain) for re-enable on new targets
  private globalEnabledDomains: Set<string> = new Set();

  // Promise used by connectToTarget to wait for the first page target
  private targetReady: Promise<void> | null = null;
  private targetReadyResolve: (() => void) | null = null;

  constructor(
    private readonly transport: ProtocolTransport,
    private readonly sender: TargetCommandSender,
  ) {
    super();
    this.bindTransportEvents();
  }

  // ========== Transport event binding ==========

  private bindTransportEvents(): void {
    this.transport.on('Target.targetCreated', (params: any) => {
      this.handleTargetCreated(params);
    });

    this.transport.on('Target.targetDestroyed', (params: any) => {
      this.handleTargetDestroyed(params);
    });
  }

  // ========== Target lifecycle ==========

  private handleTargetCreated(params: any): void {
    const info = params?.targetInfo;
    if (info?.type !== 'page') return;

    this.knownTargets.add(info.targetId);
    this.emit('target:created', { targetId: info.targetId, url: info.url });

    if (!this.activeTargetId) {
      this.activeTargetId = info.targetId;
    }

    const globalDomains = [...this.globalEnabledDomains];
    const perTargetDomains = this.enabledDomainsPerTarget.get(info.targetId);
    const domainsToEnable = new Set([...globalDomains, ...(perTargetDomains ?? [])]);

    Promise.all(
      [...domainsToEnable].map(domain =>
        this.sender.sendToTarget(`${domain}.enable`, undefined, info.targetId).catch(err => {
          console.error(`[TargetSessionManager] Failed to re-enable ${domain} on new target: ${(err as Error).message}`);
        })
      )
    ).then(() => {
      this.targetReadyResolve?.();
    });
  }

  private handleTargetDestroyed(params: any): void {
    const destroyedId = params?.targetId;
    this.knownTargets.delete(destroyedId);
    this.enabledDomainsPerTarget.delete(destroyedId);
    this.emit('target:destroyed', { targetId: destroyedId });
    if (destroyedId === this.activeTargetId) {
      this.activeTargetId = this.knownTargets.size > 0
        ? this.knownTargets.values().next().value ?? null
        : null;
    }
  }

  // ========== Target ready promise (used by connectToTarget) ==========

  /**
   * Reset state and create a new target-ready promise.
   * Called by WebKitClient just before transport.connect().
   */
  prepareForConnect(): Promise<void> {
    this.activeTargetId = null;
    this.targetReady = new Promise<void>((resolve) => {
      this.targetReadyResolve = resolve;
    });
    return this.targetReady;
  }

  /**
   * The current target-ready promise (null if prepareForConnect has not been called).
   */
  getTargetReadyPromise(): Promise<void> | null {
    return this.targetReady;
  }

  // ========== Active target ==========

  getActiveTargetId(): string | null {
    return this.activeTargetId;
  }

  setActiveTargetId(targetId: string): void {
    if (!this.knownTargets.has(targetId)) {
      throw new ConnectionError(`Target ${targetId} not found in known targets`);
    }
    this.activeTargetId = targetId;
  }

  // ========== Known targets ==========

  getKnownTargets(): Set<string> {
    return new Set(this.knownTargets);
  }

  // ========== Enabled-domain tracking ==========

  /**
   * Update the global enabled-domain set so new targets get the same domains re-enabled.
   * Called by WebKitClient.enableDomain after successful enable.
   */
  addGlobalEnabledDomain(domain: string): void {
    this.globalEnabledDomains.add(domain);
  }

  /**
   * Check whether a domain is already in the global enabled set (for dedup).
   */
  hasGlobalEnabledDomain(domain: string): boolean {
    return this.globalEnabledDomains.has(domain);
  }

  /**
   * Track that a domain was enabled for a specific target.
   */
  addEnabledDomainForTarget(domain: string, targetId: string): void {
    if (!this.enabledDomainsPerTarget.has(targetId)) {
      this.enabledDomainsPerTarget.set(targetId, new Set());
    }
    this.enabledDomainsPerTarget.get(targetId)!.add(domain);
  }

  /**
   * Return a snapshot of the enabled domains for a target.
   */
  getEnabledDomainsForTarget(targetId: string): Set<string> {
    return new Set(this.enabledDomainsPerTarget.get(targetId) ?? []);
  }

  // ========== Reset (on disconnect) ==========

  /**
   * Clear all target state. Called by WebKitClient.disconnect() and during reconnection.
   */
  reset(): void {
    this.activeTargetId = null;
    this.knownTargets.clear();
    this.enabledDomainsPerTarget.clear();
    this.targetReady = null;
    this.targetReadyResolve = null;
  }

  /**
   * Clear only the per-target state (active + known), preserving global domains.
   * Used during reconnection before re-enabling domains.
   */
  resetTargets(): void {
    this.activeTargetId = null;
    this.knownTargets.clear();
  }

  /**
   * Clear per-target enabled-domain tracking. Used during reconnection cleanup.
   */
  resetPerTargetDomains(): void {
    this.enabledDomainsPerTarget.clear();
  }

  /**
   * Clear the global enabled-domain set. Called during reconnection cleanup.
   */
  resetGlobalDomains(): void {
    this.globalEnabledDomains.clear();
  }

  /**
   * Snapshot the global enabled-domain set (for reconnection re-enable loop).
   */
  snapshotGlobalDomains(): string[] {
    return [...this.globalEnabledDomains];
  }
}
