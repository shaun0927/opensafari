import { SimulatorPool, PooledSimulator } from './pool';
import { NavigateResult, ScreenshotOptions } from '../types/browser-backend';
import { CircuitBreakerRegistry } from '../reliability/circuit-breaker';

export interface BatchResult<T> {
  device: string;
  deviceId: string;
  viewport: { w: number; h: number };
  result?: T;
  error?: string;
  timing: number;
  skipped?: boolean;
}

export class BatchExecutor {
  private readonly circuitBreakers: CircuitBreakerRegistry;

  constructor(
    private pool: SimulatorPool,
    circuitBreakers?: CircuitBreakerRegistry,
  ) {
    this.circuitBreakers = circuitBreakers ?? new CircuitBreakerRegistry();
  }

  getCircuitBreakers(): CircuitBreakerRegistry {
    return this.circuitBreakers;
  }

  private async executeOnAll<T>(
    operation: (sim: PooledSimulator) => Promise<T>
  ): Promise<BatchResult<T>[]> {
    const simulators = this.pool.getAll();
    const results: BatchResult<T>[] = [];

    // Pre-check: filter out devices with open circuits
    const available: PooledSimulator[] = [];
    for (const sim of simulators) {
      const cb = this.circuitBreakers.get(sim.device.udid);
      if (!cb.isAvailable()) {
        results.push({
          device: sim.preset,
          deviceId: sim.device.udid,
          viewport: { w: (sim.device as any).viewport?.width ?? 390, h: (sim.device as any).viewport?.height ?? 844 },
          error: 'Circuit breaker open — device excluded from batch',
          timing: 0,
          skipped: true,
        });
        continue;
      }

      // Health pre-check: verify WebKit connection is alive
      if (!sim.client.isConnected()) {
        this.circuitBreakers.get(sim.device.udid).recordFailure(new Error('WebKit not connected'));
        results.push({
          device: sim.preset,
          deviceId: sim.device.udid,
          viewport: { w: (sim.device as any).viewport?.width ?? 390, h: (sim.device as any).viewport?.height ?? 844 },
          error: 'WebKit connection not available',
          timing: 0,
          skipped: true,
        });
        continue;
      }

      available.push(sim);
    }

    const settled = await Promise.allSettled(
      available.map(async (sim): Promise<BatchResult<T>> => {
        const start = Date.now();
        this.pool.markActivity(sim.device.udid);
        try {
          const result = await operation(sim);
          this.circuitBreakers.get(sim.device.udid).recordSuccess();
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            viewport: { w: (sim.device as any).viewport?.width ?? 390, h: (sim.device as any).viewport?.height ?? 844 },
            result,
            timing: Date.now() - start,
          };
        } catch (err) {
          this.circuitBreakers.get(sim.device.udid).recordFailure(
            err instanceof Error ? err : new Error(String(err))
          );
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            viewport: { w: (sim.device as any).viewport?.width ?? 390, h: (sim.device as any).viewport?.height ?? 844 },
            error: err instanceof Error ? err.message : String(err),
            timing: Date.now() - start,
          };
        }
      })
    );

    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : {
        device: 'unknown',
        deviceId: 'unknown',
        viewport: { w: 0, h: 0 },
        error: 'Promise rejected',
        timing: 0,
      });
    }

    return results;
  }

  async batchNavigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<BatchResult<NavigateResult>[]> {
    return this.executeOnAll(async (sim) => {
      return sim.client.navigate({ url, waitUntil: waitUntil ?? 'load' });
    });
  }

  async batchScreenshot(options?: ScreenshotOptions): Promise<BatchResult<string>[]> {
    return this.executeOnAll(async (sim) => {
      const buf = await sim.client.screenshot(options);
      return buf.toString('base64');
    });
  }

  async batchExecute(expression: string): Promise<BatchResult<unknown>[]> {
    return this.executeOnAll(async (sim) => {
      return sim.client.evaluate(expression);
    });
  }
}
