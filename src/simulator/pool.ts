import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimulatorManager } from './manager';
import { SimulatorDevice } from './types';
import { DEVICE_PRESETS } from './presets';
import { WebKitClient } from '../webkit/client';
import { AuthManager } from '../auth/manager';
import * as os from 'os';
import {
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MEMORY_WARN_MB,
  DEFAULT_MEMORY_KILL_MB,
  DEFAULT_RESOURCE_CHECK_INTERVAL_MS,
} from '../config/defaults';

const execFileAsync = promisify(execFile);

export interface PooledSimulator {
  device: SimulatorDevice;
  client: WebKitClient;
  preset: string;
  bootedAt: number;
  lastActivity: number;
}

export interface SimulatorPoolOptions {
  max?: number;
  concurrency?: number;
  webkitBasePort?: number;
}

export class SimulatorPool extends EventEmitter {
  private pool: Map<string, PooledSimulator> = new Map();
  private manager: SimulatorManager;
  private maxSimulators: number;
  private concurrencyLimit: number;
  private webkitBasePort: number;
  private devicePorts: Map<string, number> = new Map();
  private nextPort: number;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private resourceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private idleTimeout: number;
  private memoryWarnMB: number;
  private memoryKillMB: number;

  constructor(options?: SimulatorPoolOptions) {
    super();
    this.manager = new SimulatorManager();
    this.maxSimulators = options?.max ?? 5;
    this.concurrencyLimit = options?.concurrency ?? 3;
    this.webkitBasePort = options?.webkitBasePort ?? 9222;
    this.nextPort = this.webkitBasePort;
    this.idleTimeout = DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS;
    this.memoryWarnMB = DEFAULT_MEMORY_WARN_MB;
    this.memoryKillMB = DEFAULT_MEMORY_KILL_MB;
  }

  async checkResources(count: number): Promise<void> {
    const requiredMB = count * 2048;
    const freeMB = Math.floor(os.freemem() / 1024 / 1024);
    if (freeMB < requiredMB) {
      throw new InsufficientResourcesError(
        `Need ~${requiredMB}MB free RAM for ${count} simulators, but only ${freeMB}MB available. Reduce device count or close other apps.`
      );
    }
  }

  async bootAll(presets: string[]): Promise<PooledSimulator[]> {
    if (presets.length > this.maxSimulators) {
      throw new Error(`Cannot boot ${presets.length} simulators (max: ${this.maxSimulators})`);
    }

    await this.checkResources(presets.length);

    // Parallel boot with concurrency limit
    const results: PooledSimulator[] = [];
    const batches: string[][] = [];
    for (let i = 0; i < presets.length; i += this.concurrencyLimit) {
      batches.push(presets.slice(i, i + this.concurrencyLimit));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (preset) => {
          const device = await this.manager.boot(preset);
          await this.manager.openUrl(device.udid, 'about:blank');

          const port = this.getPortForDevice(device.udid);
          const client = new WebKitClient({ host: 'localhost', port });

          try {
            await client.connect();
          } catch {
            // Connection may fail if ios-webkit-debug-proxy not running
            console.error(`[SimulatorPool] WebKit connection failed for ${preset} on port ${port} — proxy may not be running`);
          }

          const presetInfo = DEVICE_PRESETS[preset];
          const pooled: PooledSimulator = {
            device: { ...device, viewport: { width: presetInfo?.w ?? 390, height: presetInfo?.h ?? 844 } } as any,
            client,
            preset,
            bootedAt: Date.now(),
            lastActivity: Date.now(),
          };

          this.pool.set(device.udid, pooled);
          return pooled;
        })
      );
      results.push(...batchResults);
    }

    return results;
  }

  getAll(): PooledSimulator[] {
    return Array.from(this.pool.values());
  }

  get(deviceId: string): PooledSimulator | null {
    return this.pool.get(deviceId) ?? null;
  }

  getByPreset(preset: string): PooledSimulator | null {
    return this.getAll().find(p => p.preset === preset) ?? null;
  }

  markActivity(deviceId: string): void {
    const sim = this.pool.get(deviceId);
    if (sim) sim.lastActivity = Date.now();
  }

  getManager(): SimulatorManager {
    return this.manager;
  }

  async shutdownAll(): Promise<void> {
    this.stopIdleMonitor();
    this.stopResourceMonitor();
    await Promise.allSettled(
      this.getAll().map(async (sim) => {
        try {
          await sim.client.disconnect();
        } catch { /* best effort */ }
        try {
          await this.manager.shutdown(sim.device.udid);
        } catch { /* best effort */ }
        this.pool.delete(sim.device.udid);
      })
    );
    this.devicePorts.clear();
    this.nextPort = this.webkitBasePort;
  }

  async shutdownOne(deviceId: string): Promise<void> {
    const sim = this.pool.get(deviceId);
    if (!sim) return;
    try { await sim.client.disconnect(); } catch { /* */ }
    try { await this.manager.shutdown(deviceId); } catch { /* */ }
    this.pool.delete(deviceId);
    this.devicePorts.delete(deviceId);
  }

  startIdleMonitor(): void {
    if (this.idleCheckInterval) return;
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [deviceId, sim] of this.pool) {
        if (now - sim.lastActivity > this.idleTimeout) {
          console.error(`[SimulatorPool] Auto-shutting down idle device: ${sim.preset}`);
          this.shutdownOne(deviceId).catch(() => {});
          this.emit('simulator:shutdown', { deviceId, preset: sim.preset, reason: 'idle' });
        }
      }
    }, DEFAULT_IDLE_CHECK_INTERVAL_MS);
  }

  stopIdleMonitor(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  startResourceMonitor(): void {
    if (this.resourceCheckInterval) return;
    this.resourceCheckInterval = setInterval(async () => {
      for (const [deviceId, sim] of this.pool) {
        try {
          const memMB = await this.getSimulatorMemory(deviceId);
          if (memMB > this.memoryKillMB) {
            this.emit('simulator:memory-critical', { deviceId, preset: sim.preset, memMB, threshold: this.memoryKillMB });
          } else if (memMB > this.memoryWarnMB) {
            this.emit('simulator:memory-warning', { deviceId, preset: sim.preset, memMB, threshold: this.memoryWarnMB });
          }
        } catch {
          // Process may have exited
        }
      }
    }, DEFAULT_RESOURCE_CHECK_INTERVAL_MS);
  }

  stopResourceMonitor(): void {
    if (this.resourceCheckInterval) {
      clearInterval(this.resourceCheckInterval);
      this.resourceCheckInterval = null;
    }
  }

  async injectAuth(authProfile: string): Promise<void> {
    const authManager = new AuthManager();
    const profile = await authManager.loadProfile(authProfile);
    for (const sim of this.getAll()) {
      if (!sim.client.isConnected()) continue;
      try {
        await sim.client.setCookies(profile.cookies);
        if (profile.localStorage && Object.keys(profile.localStorage).length > 0) {
          await sim.client.evaluate(`
            (function(data) {
              Object.entries(data).forEach(function(e) { localStorage.setItem(e[0], e[1]); });
            })(${JSON.stringify(profile.localStorage)})
          `);
        }
      } catch (err) {
        console.error(`[SimulatorPool] Auth injection failed for ${sim.preset}: ${err}`);
      }
    }
  }

  get size(): number {
    return this.pool.size;
  }

  private getPortForDevice(deviceId: string): number {
    if (!this.devicePorts.has(deviceId)) {
      this.devicePorts.set(deviceId, this.nextPort++);
    }
    return this.devicePorts.get(deviceId)!;
  }

  private async getSimulatorMemory(deviceId: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', deviceId]);
      const pids = stdout.trim().split('\n').filter(Boolean);
      let totalKB = 0;
      for (const pid of pids) {
        try {
          const { stdout: rss } = await execFileAsync('ps', ['-o', 'rss=', '-p', pid]);
          totalKB += parseInt(rss.trim(), 10) || 0;
        } catch { /* process gone */ }
      }
      return Math.floor(totalKB / 1024);
    } catch {
      return 0;
    }
  }
}

export class InsufficientResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientResourcesError';
  }
}
