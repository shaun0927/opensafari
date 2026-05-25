import { EventEmitter } from 'events';
import { BrowserBackend } from './types/browser-backend';

/**
 * Session Manager — Simulator & Safari Connection Tracking
 *
 * Maps booted simulators to WebKit Protocol connections (BrowserBackend instances).
 * Manages workers and connection lifecycle.
 *
 * Phase 3 of #408 removed the `activeDeviceId` global field. Tools that do not
 * specify a deviceId fall back to the unique booted device (if exactly one is
 * connected) instead of a process-wide "active" pointer that two concurrent
 * sessions could silently overwrite.
 */

export interface SimulatorInfo {
  deviceId: string;
  deviceType: string;
  state: 'booted' | 'shutdown';
  viewport: { width: number; height: number };
  bootedAt: number;
  lastActivity: number;
}

export interface WorkerInfo {
  name: string;
  deviceId: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  results?: unknown;
  error?: string;
}

/**
 * A single QA session mapped to an isolated Safari tab within a simulator.
 * Multiple sessions can target the same simulator but different tabs, enabling
 * parallel QA without the memory cost of booting multiple simulators.
 */
export interface TabSessionInfo {
  sessionId: string;
  deviceId: string;
  targetId: string;
  url: string;
  client: BrowserBackend;
  createdAt: number;
}

export class SessionManager extends EventEmitter {
  private simulators: Map<string, SimulatorInfo> = new Map();
  private connections: Map<string, BrowserBackend> = new Map();
  private workers: Map<string, WorkerInfo> = new Map();
  private tabSessions: Map<string, TabSessionInfo> = new Map();

  // Simulator tracking
  addSimulator(deviceId: string, info: SimulatorInfo): void {
    this.simulators.set(deviceId, info);
    this.emit('simulator:added', { deviceId, info });
  }

  removeSimulator(deviceId: string): void {
    this.simulators.delete(deviceId);
    this.connections.delete(deviceId);
    this.emit('simulator:removed', { deviceId });
  }

  getSimulator(deviceId: string): SimulatorInfo | null {
    return this.simulators.get(deviceId) ?? null;
  }

  listSimulators(): SimulatorInfo[] {
    return Array.from(this.simulators.values());
  }

  // Connection management
  setConnection(deviceId: string, client: BrowserBackend): void {
    this.connections.set(deviceId, client);
    this.emit('connection:established', { deviceId });
  }

  /**
   * Look up a registered BrowserBackend connection.
   *
   * Resolution rules (Phase 3 of #408 — `activeDeviceId` has been removed):
   *   - If `deviceId` is supplied, return the connection for that device (or null).
   *   - If `deviceId` is omitted AND exactly one device is connected, return
   *     that sole connection — this preserves the single-device workflow
   *     without any global state.
   *   - Otherwise (zero or multiple connections), return null. Callers that
   *     need an explicit choice in multi-device scenarios should use
   *     `listConnections()` and pick one themselves, or surface a structured
   *     error listing available devices.
   */
  getConnection(deviceId?: string): BrowserBackend | null {
    if (deviceId) {
      return this.connections.get(deviceId) ?? null;
    }
    if (this.connections.size === 1) {
      const sole = this.connections.values().next().value;
      return sole ?? null;
    }
    return null;
  }

  /**
   * Return the sole device id when the session is in unambiguous single-device
   * mode. Prefers the unique WebKit connection (so Safari tools work as soon
   * as device_boot finishes), then falls back to the unique registered
   * simulator (so native app tools work even before a WebKit connection is
   * established). Returns null whenever zero or multiple devices are present
   * — callers that need to pick in multi-device scenarios must ask the
   * caller for an explicit `deviceId`.
   */
  getSoleDeviceId(): string | null {
    if (this.connections.size === 1) {
      return this.connections.keys().next().value ?? null;
    }
    if (this.simulators.size === 1) {
      return this.simulators.keys().next().value ?? null;
    }
    return null;
  }

  removeConnection(deviceId: string): void {
    this.connections.delete(deviceId);
    this.emit('connection:removed', { deviceId });
  }

  hasConnection(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  listConnections(): Array<{ deviceId: string; client: BrowserBackend }> {
    return Array.from(this.connections.entries()).map(([deviceId, client]) => ({ deviceId, client }));
  }

  markActivity(deviceId: string): void {
    const sim = this.simulators.get(deviceId);
    if (sim) {
      sim.lastActivity = Date.now();
    }
  }

  // Tab session management (Phase 2A of #408)

  /**
   * Register a new tab-scoped QA session. Each session is a Safari tab on a
   * simulator, addressable by a unique sessionId. Tools can route calls to a
   * specific session instead of the device's default connection.
   */
  addTabSession(info: TabSessionInfo): void {
    this.tabSessions.set(info.sessionId, info);
    this.emit('tab-session:added', { sessionId: info.sessionId, deviceId: info.deviceId });
  }

  /**
   * Look up a tab session's BrowserBackend by sessionId.
   */
  getTabSession(sessionId: string): TabSessionInfo | null {
    return this.tabSessions.get(sessionId) ?? null;
  }

  /**
   * Remove a tab session from the registry. Does NOT close the tab or
   * disconnect the client — callers must do that first.
   */
  removeTabSession(sessionId: string): void {
    if (this.tabSessions.delete(sessionId)) {
      this.emit('tab-session:removed', { sessionId });
    }
  }

  /**
   * List all active tab sessions, optionally filtered by deviceId.
   */
  listTabSessions(deviceId?: string): TabSessionInfo[] {
    const all = Array.from(this.tabSessions.values());
    return deviceId ? all.filter((s) => s.deviceId === deviceId) : all;
  }

  // Worker management (for Phase 2 orchestration)
  createWorker(name: string, deviceId: string): WorkerInfo {
    const worker: WorkerInfo = {
      name,
      deviceId,
      status: 'pending',
      startedAt: Date.now(),
    };
    this.workers.set(name, worker);
    this.emit('worker:created', { name, deviceId });
    return worker;
  }

  getWorker(name: string): WorkerInfo | null {
    return this.workers.get(name) ?? null;
  }

  listWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  updateWorkerStatus(name: string, status: WorkerInfo['status'], data?: { results?: unknown; error?: string }): void {
    const worker = this.workers.get(name);
    if (!worker) return;
    worker.status = status;
    if (data?.results) worker.results = data.results;
    if (data?.error) worker.error = data.error;
    if (status === 'completed' || status === 'failed') {
      worker.completedAt = Date.now();
    }
    this.emit('worker:updated', { name, status });
  }

  removeWorker(name: string): void {
    this.workers.delete(name);
    this.emit('worker:removed', { name });
  }

  /**
   * Re-discover already-booted simulators after an MCP client reconnects.
   *
   * The SessionManager state is in-memory only. When the MCP transport
   * drops and reconnects (e.g. CLI restart, IDE reload, process recycle)
   * the maps come back empty even though `simctl list booted` still
   * reports the same UDIDs. Tools then think "no device booted" and the
   * LLM either re-runs `device_boot` (wasting 20 s + risking a fresh
   * cold-boot) or fails outright.
   *
   * Rehydration walks the live `simctl list devices -j` snapshot and
   * re-registers each booted device with the SessionManager. WebKit /
   * Flutter VM connections are NOT re-established here — those need a
   * proxy and an open Safari target, which `device_boot`'s fast path
   * (PR7) already handles cleanly. We just rebuild the lightweight
   * SimulatorInfo entries so `getSoleDeviceId()` and `listSimulators()`
   * work on the very next tool call.
   *
   * Idempotent — safe to call multiple times. The caller passes the
   * lookup interface so this module doesn't have to import simulator
   * code (avoids a circular dependency).
   */
  async rehydrateFromSimctl(
    lookup: { listBooted: () => Promise<Array<{ udid: string; name: string }>> },
    options?: { presetLookup?: (deviceType: string) => { w: number; h: number } | undefined },
  ): Promise<{ rehydrated: string[]; skipped: string[] }> {
    const rehydrated: string[] = [];
    const skipped: string[] = [];
    let booted: Array<{ udid: string; name: string }> = [];
    try {
      booted = await lookup.listBooted();
    } catch (err) {
      console.error(
        `[SessionManager] rehydrateFromSimctl failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { rehydrated, skipped };
    }
    for (const device of booted) {
      if (this.simulators.has(device.udid)) {
        skipped.push(device.udid);
        continue;
      }
      const viewport = options?.presetLookup?.(device.name) ?? { w: 390, h: 844 };
      this.addSimulator(device.udid, {
        deviceId: device.udid,
        deviceType: device.name,
        state: 'booted',
        viewport: { width: viewport.w, height: viewport.h },
        // bootedAt is unknowable post-reconnect; use now as a lower bound.
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
      rehydrated.push(device.udid);
    }
    return { rehydrated, skipped };
  }

  // Cleanup
  async shutdown(): Promise<void> {
    for (const session of this.tabSessions.values()) {
      try {
        await session.client.disconnect();
      } catch {
        // Best effort
      }
    }
    this.tabSessions.clear();
    for (const [, client] of this.connections) {
      try {
        await client.disconnect();
      } catch {
        // Best effort
      }
    }
    this.connections.clear();
    this.simulators.clear();
    this.workers.clear();
    this.emit('session:shutdown');
  }
}

// Singleton
let sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}
