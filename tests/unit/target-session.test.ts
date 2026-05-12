/**
 * Tests for TargetSessionManager (#706 3/5).
 *
 * Covers:
 * - target add on Target.targetCreated
 * - target remove on Target.targetDestroyed
 * - listTargets() snapshot (getKnownTargets)
 * - setActiveTargetId happy path + invalid id error
 * - per-target enabled-domain set is independent across targets
 * - per-target enabled-domain set clears on target destroyed
 */

import { EventEmitter } from 'events';
import { TargetSessionManager, TargetCommandSender } from '../../src/webkit/target-session';
import { ConnectionError } from '../../src/webkit/errors';
import type { ProtocolTransport } from '../../src/webkit/protocol-transport';

// ─── Minimal transport stub ───────────────────────────────────────────────────

class FakeTransport extends EventEmitter implements ProtocolTransport {
  connect(_wsUrl: string): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  isConnected(): boolean { return true; }
  sendToTarget<T>(): Promise<T> { return Promise.resolve({} as T); }
  onProtocolEvent(): () => void { return () => {}; }
}

// ─── Minimal sender stub ─────────────────────────────────────────────────────

class FakeSender implements TargetCommandSender {
  calls: Array<{ method: string; targetId?: string | null }> = [];

  async sendToTarget<T>(method: string, _params?: Record<string, unknown>, targetId?: string | null): Promise<T> {
    this.calls.push({ method, targetId });
    return {} as T;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeManager(): {
  manager: TargetSessionManager;
  transport: FakeTransport;
  sender: FakeSender;
} {
  const transport = new FakeTransport();
  const sender = new FakeSender();
  const manager = new TargetSessionManager(transport, sender);
  return { manager, transport, sender };
}

function emitTargetCreated(transport: FakeTransport, targetId: string, url = 'about:blank', type = 'page'): void {
  transport.emit('Target.targetCreated', { targetInfo: { targetId, url, type } });
}

function emitTargetDestroyed(transport: FakeTransport, targetId: string): void {
  transport.emit('Target.targetDestroyed', { targetId });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TargetSessionManager', () => {

  // ── Target.targetCreated ───────────────────────────────────────────────────

  it('adds target to known set on Target.targetCreated', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    expect(manager.getKnownTargets().has('page-1')).toBe(true);
  });

  it('ignores non-page targets on Target.targetCreated', () => {
    const { manager, transport } = makeManager();
    transport.emit('Target.targetCreated', { targetInfo: { targetId: 'worker-1', url: 'about:blank', type: 'worker' } });
    expect(manager.getKnownTargets().size).toBe(0);
  });

  it('sets activeTargetId to first page target created', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    expect(manager.getActiveTargetId()).toBe('page-1');
  });

  it('does not override activeTargetId when a second target arrives', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    expect(manager.getActiveTargetId()).toBe('page-1');
  });

  it('emits target:created event', () => {
    const { manager, transport } = makeManager();
    const events: any[] = [];
    manager.on('target:created', (payload) => events.push(payload));
    emitTargetCreated(transport, 'page-1', 'https://example.com');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ targetId: 'page-1', url: 'https://example.com' });
  });

  // ── Target.targetDestroyed ─────────────────────────────────────────────────

  it('removes target from known set on Target.targetDestroyed', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetDestroyed(transport, 'page-1');
    expect(manager.getKnownTargets().has('page-1')).toBe(false);
  });

  it('emits target:destroyed event', () => {
    const { manager, transport } = makeManager();
    const events: any[] = [];
    manager.on('target:destroyed', (payload) => events.push(payload));
    emitTargetCreated(transport, 'page-1');
    emitTargetDestroyed(transport, 'page-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ targetId: 'page-1' });
  });

  it('falls back activeTargetId to another known target when active is destroyed', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    emitTargetDestroyed(transport, 'page-1');
    expect(manager.getActiveTargetId()).toBe('page-2');
  });

  it('sets activeTargetId to null when last target is destroyed', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetDestroyed(transport, 'page-1');
    expect(manager.getActiveTargetId()).toBeNull();
  });

  it('does not change activeTargetId when a non-active target is destroyed', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    emitTargetDestroyed(transport, 'page-2');
    expect(manager.getActiveTargetId()).toBe('page-1');
  });

  // ── getKnownTargets snapshot ───────────────────────────────────────────────

  it('getKnownTargets returns a snapshot not the internal set', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    const snapshot = manager.getKnownTargets();
    emitTargetCreated(transport, 'page-2');
    // snapshot should still be size 1 — it's a copy
    expect(snapshot.size).toBe(1);
    expect(manager.getKnownTargets().size).toBe(2);
  });

  it('listTargets via getKnownTargets reflects all known page targets', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    emitTargetCreated(transport, 'page-3');
    const ids = [...manager.getKnownTargets()].sort();
    expect(ids).toEqual(['page-1', 'page-2', 'page-3']);
  });

  // ── setActiveTargetId ──────────────────────────────────────────────────────

  it('setActiveTargetId happy path switches active target', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    manager.setActiveTargetId('page-2');
    expect(manager.getActiveTargetId()).toBe('page-2');
  });

  it('setActiveTargetId throws ConnectionError for unknown id', () => {
    const { manager } = makeManager();
    expect(() => manager.setActiveTargetId('nonexistent')).toThrow(ConnectionError);
    expect(() => manager.setActiveTargetId('nonexistent')).toThrow('not found');
  });

  // ── Per-target enabled-domain Sets ────────────────────────────────────────

  it('per-target domain sets are independent across targets', () => {
    const { manager } = makeManager();
    manager.addEnabledDomainForTarget('Page', 'target-1');
    manager.addEnabledDomainForTarget('Runtime', 'target-2');

    expect(manager.getEnabledDomainsForTarget('target-1').has('Page')).toBe(true);
    expect(manager.getEnabledDomainsForTarget('target-1').has('Runtime')).toBe(false);
    expect(manager.getEnabledDomainsForTarget('target-2').has('Runtime')).toBe(true);
    expect(manager.getEnabledDomainsForTarget('target-2').has('Page')).toBe(false);
  });

  it('getEnabledDomainsForTarget returns empty set for unknown target', () => {
    const { manager } = makeManager();
    expect(manager.getEnabledDomainsForTarget('unknown').size).toBe(0);
  });

  it('per-target domain set clears on target destroyed', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    manager.addEnabledDomainForTarget('Page', 'page-1');
    manager.addEnabledDomainForTarget('Runtime', 'page-1');
    expect(manager.getEnabledDomainsForTarget('page-1').size).toBe(2);

    emitTargetDestroyed(transport, 'page-1');
    expect(manager.getEnabledDomainsForTarget('page-1').size).toBe(0);
  });

  it('destroying one target does not clear domains of another', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    emitTargetCreated(transport, 'page-2');
    manager.addEnabledDomainForTarget('Page', 'page-1');
    manager.addEnabledDomainForTarget('Runtime', 'page-2');

    emitTargetDestroyed(transport, 'page-1');
    expect(manager.getEnabledDomainsForTarget('page-2').has('Runtime')).toBe(true);
  });

  // ── Global enabled-domain set ─────────────────────────────────────────────

  it('hasGlobalEnabledDomain returns false before adding', () => {
    const { manager } = makeManager();
    expect(manager.hasGlobalEnabledDomain('Page')).toBe(false);
  });

  it('hasGlobalEnabledDomain returns true after addGlobalEnabledDomain', () => {
    const { manager } = makeManager();
    manager.addGlobalEnabledDomain('Page');
    expect(manager.hasGlobalEnabledDomain('Page')).toBe(true);
  });

  it('snapshotGlobalDomains returns a copy of the global set', () => {
    const { manager } = makeManager();
    manager.addGlobalEnabledDomain('Page');
    manager.addGlobalEnabledDomain('Runtime');
    const snap = manager.snapshotGlobalDomains();
    expect(snap.sort()).toEqual(['Page', 'Runtime']);
  });

  it('resetGlobalDomains clears the global set', () => {
    const { manager } = makeManager();
    manager.addGlobalEnabledDomain('Page');
    manager.resetGlobalDomains();
    expect(manager.hasGlobalEnabledDomain('Page')).toBe(false);
  });

  // ── prepareForConnect / reset ──────────────────────────────────────────────

  it('prepareForConnect returns a promise that resolves when first page target arrives', async () => {
    const { manager, transport } = makeManager();
    const ready = manager.prepareForConnect();

    let resolved = false;
    ready.then(() => { resolved = true; });

    // Not resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Emit target — triggers re-enable chain which calls resolve
    emitTargetCreated(transport, 'page-1');

    // Allow microtasks to settle
    await ready;
    expect(resolved).toBe(true);
  });

  it('reset clears all state', () => {
    const { manager, transport } = makeManager();
    emitTargetCreated(transport, 'page-1');
    manager.addEnabledDomainForTarget('Page', 'page-1');
    manager.addGlobalEnabledDomain('Runtime');

    manager.reset();

    expect(manager.getKnownTargets().size).toBe(0);
    expect(manager.getActiveTargetId()).toBeNull();
    expect(manager.getEnabledDomainsForTarget('page-1').size).toBe(0);
    // global domains are NOT cleared by reset() — use resetGlobalDomains() for that
    expect(manager.hasGlobalEnabledDomain('Runtime')).toBe(true);
  });
});
