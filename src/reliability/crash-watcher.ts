import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
import { CircuitBreakerRegistry } from './circuit-breaker';
import { removeFlutterVMClient } from '../flutter';
import { forgetVMServiceUrl } from '../flutter/vm-service-discovery';
import { flutterCircuitBreakers } from '../flutter/flutter-circuit-breakers';

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
    // Watchdogs must never be the thing keeping the process alive.
    this.interval.unref();
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
            // Trip the Flutter-side breaker too so any in-flight
            // `flutter_*` tool calls fail fast instead of hanging on a
            // dead simulator.
            flutterCircuitBreakers().get(deviceId).trip();
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

      // Tear down any Flutter VM Service state for this device. The
      // simulator is being re-booted; the singleton FlutterVMClient is
      // pointing at a now-dead WebSocket and a stale isolate id. Without
      // this, the next `flutter_connect` against the same UDID would
      // inherit and surface confusing NO_ISOLATE / NOT_CONNECTED errors.
      try {
        removeFlutterVMClient(deviceId);
        forgetVMServiceUrl(deviceId);
      } catch (err) {
        console.error(`[CrashWatcher] Flutter cleanup failed for ${deviceId}: ${err}`);
      }

      // Re-boot
      await manager.boot(sim.preset);

      // Reconnect WebKit (track outcome so 'recovered' isn't claimed when
      // the WebKit reconnect actually failed — caller may want to retry
      // or open the circuit again instead of pretending we healed).
      let webkitOk = false;
      try {
        await sim.client.connect();
        webkitOk = true;
      } catch {
        console.error(`[CrashWatcher] WebKit reconnect failed for ${sim.preset}`);
      }

      // Restore auth if available
      let authOk = true;
      if (this.authProfile) {
        try {
          await this.pool.injectAuth(this.authProfile);
        } catch {
          console.error(`[CrashWatcher] Auth restore failed for ${sim.preset}`);
          authOk = false;
        }
      }

      this.knownStates.set(deviceId, 'Booted');

      if (webkitOk && authOk) {
        this.circuitBreakers?.get(deviceId).reset();
        // Reset the Flutter-side breaker too so the next flutter_connect
        // against this device isn't blocked by the pre-crash failure
        // accounting carried in the registry.
        flutterCircuitBreakers().get(deviceId).reset();
        const duration = Date.now() - startTime;
        console.error(`[CrashWatcher] Recovered ${sim.preset} in ${duration}ms`);
        this.emit('recovered', { deviceId, duration });
      } else {
        const duration = Date.now() - startTime;
        console.error(
          `[CrashWatcher] Partial recovery for ${sim.preset} (webkit=${webkitOk}, auth=${authOk})`,
        );
        this.emit('recovery-partial', { deviceId, duration, webkitOk, authOk });
      }
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
