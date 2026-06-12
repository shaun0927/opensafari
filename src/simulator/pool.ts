import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimulatorManager } from './manager';
import { SimulatorDevice } from './types';
import { DEVICE_PRESETS } from './presets';
import { WebKitClient } from '../webkit/client';
import { AuthManager } from '../auth/manager';
import { BrowserBackend, Cookie } from '../types/browser-backend';
import * as os from 'os';
import {
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MEMORY_WARN_MB,
  DEFAULT_MEMORY_KILL_MB,
  DEFAULT_RESOURCE_CHECK_INTERVAL_MS,
} from '../config/defaults';
import { registerManagedDevices, unregisterManagedDevices } from '../reliability/zombie-cleanup';
import { CircuitBreakerRegistry } from '../reliability/circuit-breaker';
import { getSessionManager } from '../session-manager';

const execFileAsync = promisify(execFile);

/** Ensures the process exit handler is registered only once across all pool instances. */
let exitHandlerRegistered = false;

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
  private circuitBreakers: CircuitBreakerRegistry | null = null;
  private memoryCriticalHandlerRegistered = false;
  private tempAuthState: Map<string, { cookies: Cookie[]; localStorage: Record<string, string> }> = new Map();

  constructor(options?: SimulatorPoolOptions) {
    super();
    this.manager = new SimulatorManager();
    this.maxSimulators = options?.max ?? 5;
    this.concurrencyLimit = options?.concurrency ?? 3;
    this.webkitBasePort = options?.webkitBasePort ?? 9322;
    this.nextPort = this.webkitBasePort;
    this.idleTimeout = DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS;
    this.memoryWarnMB = DEFAULT_MEMORY_WARN_MB;
    this.memoryKillMB = DEFAULT_MEMORY_KILL_MB;

    // Ensure the shared device registry is cleaned up when the process exits
    if (!exitHandlerRegistered) {
      exitHandlerRegistered = true;
      process.on('exit', () => {
        unregisterManagedDevices();
      });
    }
  }

  setCircuitBreakers(registry: CircuitBreakerRegistry): void {
    this.circuitBreakers = registry;
  }

  private setupMemoryCriticalHandler(): void {
    if (this.memoryCriticalHandlerRegistered) return;
    this.memoryCriticalHandlerRegistered = true;

    this.on('simulator:memory-critical', async (event: { deviceId: string; preset: string; memMB: number; threshold: number }) => {
      console.error(
        `[SimulatorPool] Memory critical for ${event.preset}: ${event.memMB}MB exceeds ${event.threshold}MB threshold`
      );

      // Trip circuit breaker to exclude device from batch operations
      if (this.circuitBreakers) {
        this.circuitBreakers.get(event.deviceId).trip();
      }

      // Gracefully shutdown the offending device
      try {
        await this.shutdownOne(event.deviceId);
        console.error(`[SimulatorPool] Shut down memory-critical device: ${event.preset}`);
      } catch (err) {
        console.error(`[SimulatorPool] Failed to shut down memory-critical device ${event.preset}: ${err}`);
      }
    });
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
          await this.manager.openUrl(device.udid, 'https://example.com');

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

    // Register all booted devices in the shared cross-process registry
    const udids = results.map(r => r.device.udid);
    registerManagedDevices(udids);

    // Sync pool state to SessionManager for unified connection tracking
    const sm = getSessionManager();
    for (const pooled of results) {
      const presetInfo = DEVICE_PRESETS[pooled.preset];
      sm.addSimulator(pooled.device.udid, {
        deviceId: pooled.device.udid,
        deviceType: pooled.device.name,
        state: 'booted',
        viewport: { width: presetInfo?.w ?? 390, height: presetInfo?.h ?? 844 },
        bootedAt: pooled.bootedAt,
        lastActivity: pooled.lastActivity,
      });
      if (pooled.client.isConnected()) {
        sm.setConnection(pooled.device.udid, pooled.client);
      }
    }

    return results;
  }

  /**
   * Boot devices sequentially: one at a time, run a task, then shut down.
   * Peak RAM = 1 simulator (~2GB) regardless of device count.
   */
  async bootSequential(
    presets: string[],
    runner: (sim: PooledSimulator, preset: string, index: number) => Promise<unknown>,
  ): Promise<Array<{ preset: string; status: 'completed' | 'failed'; result?: unknown; error?: string; duration: number }>> {
    const results: Array<{ preset: string; status: 'completed' | 'failed'; result?: unknown; error?: string; duration: number }> = [];

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const start = Date.now();
      let sim: PooledSimulator | null = null;

      try {
        await this.checkResources(1);
        const device = await this.manager.boot(preset);
        await this.manager.openUrl(device.udid, 'https://example.com');

        const port = this.getPortForDevice(device.udid);
        const client = new WebKitClient({ host: 'localhost', port });

        try {
          await client.connect();
        } catch {
          console.error(`[SimulatorPool] Sequential: WebKit connection failed for ${preset}`);
        }

        const presetInfo = DEVICE_PRESETS[preset];
        sim = {
          device: { ...device, viewport: { width: presetInfo?.w ?? 390, height: presetInfo?.h ?? 844 } } as any,
          client,
          preset,
          bootedAt: Date.now(),
          lastActivity: Date.now(),
        };

        this.pool.set(device.udid, sim);
        const sm = getSessionManager();
        sm.addSimulator(device.udid, {
          deviceId: device.udid,
          deviceType: device.name,
          state: 'booted',
          viewport: { width: presetInfo?.w ?? 390, height: presetInfo?.h ?? 844 },
          bootedAt: sim.bootedAt,
          lastActivity: sim.lastActivity,
        });
        if (client.isConnected()) {
          sm.setConnection(device.udid, client);
        }

        const result = await runner(sim, preset, i);
        results.push({ preset, status: 'completed', result, duration: Date.now() - start });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SimulatorPool] Sequential: ${preset} failed: ${msg}`);
        results.push({ preset, status: 'failed', error: msg, duration: Date.now() - start });
      } finally {
        // Always shut down before moving to next device — wrapped in try/catch
        // to prevent shutdown failures from aborting the remaining devices
        if (sim) {
          try {
            await this.shutdownOne(sim.device.udid);
          } catch (shutdownErr) {
            console.error(`[SimulatorPool] Sequential: shutdown failed for ${preset}: ${shutdownErr}`);
          }
        }
      }
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
    const sm = getSessionManager();
    await Promise.allSettled(
      this.getAll().map(async (sim) => {
        try {
          await sim.client.disconnect();
        } catch { /* best effort */ }
        try {
          await this.manager.shutdown(sim.device.udid);
        } catch { /* best effort */ }
        sm.removeSimulator(sim.device.udid);
        this.pool.delete(sim.device.udid);
      })
    );
    this.devicePorts.clear();
    this.nextPort = this.webkitBasePort;

    // Remove all devices from the shared cross-process registry
    unregisterManagedDevices();
  }

  async shutdownOne(deviceId: string): Promise<void> {
    const sim = this.pool.get(deviceId);
    if (!sim) return;
    try { await sim.client.disconnect(); } catch { /* */ }
    try { await this.manager.shutdown(deviceId); } catch { /* */ }
    getSessionManager().removeSimulator(deviceId);
    this.pool.delete(deviceId);
    this.devicePorts.delete(deviceId);

    // Update the shared registry with remaining devices
    const remainingUdids = Array.from(this.pool.keys());
    if (remainingUdids.length > 0) {
      registerManagedDevices(remainingUdids);
    } else {
      unregisterManagedDevices();
    }
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
    // Monitors must never be the thing keeping the process alive.
    this.idleCheckInterval.unref();
  }

  stopIdleMonitor(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  startResourceMonitor(): void {
    if (this.resourceCheckInterval) return;
    this.setupMemoryCriticalHandler();
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
    // Monitors must never be the thing keeping the process alive.
    this.resourceCheckInterval.unref();
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

  /**
   * Save temporary auth state for transfer between sequential devices.
   * Called before shutting down a device in a sequential workflow.
   */
  async saveTempAuth(workflowId: string, client: BrowserBackend): Promise<void> {
    try {
      const cookies = await client.getCookies();
      const localStorage = await client.evaluate<Record<string, string>>(`
        (function() {
          var data = {};
          for (var i = 0; i < window.localStorage.length; i++) {
            var key = window.localStorage.key(i);
            if (key) data[key] = window.localStorage.getItem(key) || '';
          }
          return data;
        })()
      `) ?? {};
      this.tempAuthState.set(workflowId, { cookies, localStorage });
    } catch (err) {
      console.error(`[SimulatorPool] Failed to save temp auth for ${workflowId}: ${err}`);
    }
  }

  /**
   * Restore temporary auth state onto a newly booted sequential device.
   * Called after connecting to a new device in a sequential workflow.
   */
  async restoreTempAuth(workflowId: string, client: BrowserBackend): Promise<boolean> {
    const state = this.tempAuthState.get(workflowId);
    if (!state) return false;
    try {
      await client.setCookies(state.cookies);
      if (Object.keys(state.localStorage).length > 0) {
        await client.evaluate(`
          (function(data) {
            Object.entries(data).forEach(function(e) { localStorage.setItem(e[0], e[1]); });
          })(${JSON.stringify(state.localStorage)})
        `);
      }
      return true;
    } catch (err) {
      console.error(`[SimulatorPool] Failed to restore temp auth for ${workflowId}: ${err}`);
      return false;
    }
  }

  /**
   * Seed temporary auth state directly (e.g. from a loaded auth profile).
   */
  setTempAuth(workflowId: string, cookies: Cookie[], localStorage: Record<string, string>): void {
    this.tempAuthState.set(workflowId, { cookies, localStorage });
  }

  /**
   * Clear temporary auth state after workflow completion.
   */
  clearTempAuth(workflowId: string): void {
    this.tempAuthState.delete(workflowId);
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
