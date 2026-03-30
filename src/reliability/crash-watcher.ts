import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
import { CircuitBreakerRegistry } from './circuit-breaker';

export class SimulatorCrashWatcher extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private knownStates: Map<string, string> = new Map();

  constructor(
    private pool: SimulatorPool,
    private authProfile?: string,
    private circuitBreakers?: CircuitBreakerRegistry,
  ) {
    super();
  }

  start(checkIntervalMs = 10000): void {
    if (this.interval) return;

    // Initialize known states
    for (const sim of this.pool.getAll()) {
      this.knownStates.set(sim.device.udid, 'Booted');
    }

    this.interval = setInterval(() => this.check(), checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    const manager = this.pool.getManager();
    for (const [deviceId, previousState] of this.knownStates) {
      try {
        const device = await manager.getDevice(deviceId);
        if (!device || device.state !== 'Booted') {
          if (previousState === 'Booted') {
            console.error(`[CrashWatcher] Simulator ${deviceId} crashed (was Booted, now ${device?.state ?? 'gone'})`);
            this.circuitBreakers?.get(deviceId).trip();
            this.emit('crash', { deviceId });
            await this.recover(deviceId);
          }
        }
      } catch {
        // Device may be gone entirely
      }
    }
  }

  private async recover(deviceId: string): Promise<void> {
    const startTime = Date.now();
    try {
      const manager = this.pool.getManager();
      const sim = this.pool.get(deviceId);
      if (!sim) return;

      console.error(`[CrashWatcher] Recovering ${sim.preset}...`);

      // Re-boot
      await manager.boot(sim.preset);

      // Reconnect WebKit
      try {
        await sim.client.connect();
      } catch {
        console.error(`[CrashWatcher] WebKit reconnect failed for ${sim.preset}`);
      }

      // Restore auth if available
      if (this.authProfile) {
        try {
          await this.pool.injectAuth(this.authProfile);
        } catch {
          console.error(`[CrashWatcher] Auth restore failed for ${sim.preset}`);
        }
      }

      this.knownStates.set(deviceId, 'Booted');
      this.circuitBreakers?.get(deviceId).reset();
      const duration = Date.now() - startTime;
      console.error(`[CrashWatcher] Recovered ${sim.preset} in ${duration}ms`);
      this.emit('recovered', { deviceId, duration });
    } catch (err) {
      console.error(`[CrashWatcher] Recovery failed for ${deviceId}: ${err}`);
      this.emit('recovery-failed', { deviceId, error: err });
    }
  }

  addDevice(deviceId: string): void {
    this.knownStates.set(deviceId, 'Booted');
  }

  removeDevice(deviceId: string): void {
    this.knownStates.delete(deviceId);
  }
}
