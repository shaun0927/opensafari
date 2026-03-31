import { EventEmitter } from 'events';
import { BrowserBackend } from './types/browser-backend';

/**
 * Session Manager — Simulator & Safari Connection Tracking
 *
 * Maps booted simulators to WebKit Protocol connections (BrowserBackend instances).
 * Manages active device, workers, and connection lifecycle.
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

export class SessionManager extends EventEmitter {
  private simulators: Map<string, SimulatorInfo> = new Map();
  private connections: Map<string, BrowserBackend> = new Map();
  private workers: Map<string, WorkerInfo> = new Map();
  private activeDeviceId: string | null = null;

  // Simulator tracking
  addSimulator(deviceId: string, info: SimulatorInfo): void {
    this.simulators.set(deviceId, info);
    this.emit('simulator:added', { deviceId, info });
    if (!this.activeDeviceId) {
      this.activeDeviceId = deviceId;
    }
  }

  removeSimulator(deviceId: string): void {
    this.simulators.delete(deviceId);
    this.connections.delete(deviceId);
    this.emit('simulator:removed', { deviceId });
    if (this.activeDeviceId === deviceId) {
      this.activeDeviceId = this.simulators.size > 0
        ? this.simulators.keys().next().value ?? null
        : null;
    }
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

  getConnection(deviceId?: string): BrowserBackend | null {
    const id = deviceId ?? this.activeDeviceId;
    if (!id) return null;
    return this.connections.get(id) ?? null;
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

  // Active device
  setActiveDevice(deviceId: string): void {
    if (!this.simulators.has(deviceId)) {
      throw new Error(`Device ${deviceId} not found in session`);
    }
    this.activeDeviceId = deviceId;
    this.emit('device:active', { deviceId });
  }

  getActiveDeviceId(): string | null {
    return this.activeDeviceId;
  }

  markActivity(deviceId: string): void {
    const sim = this.simulators.get(deviceId);
    if (sim) {
      sim.lastActivity = Date.now();
    }
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

  // Cleanup
  async shutdown(): Promise<void> {
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
    this.activeDeviceId = null;
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
