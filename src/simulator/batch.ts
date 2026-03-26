import { SimulatorPool, PooledSimulator } from './pool';
import { NavigateResult, ScreenshotOptions } from '../types/browser-backend';

export interface BatchResult<T> {
  device: string;
  deviceId: string;
  viewport: { w: number; h: number };
  result?: T;
  error?: string;
  timing: number;
}

export class BatchExecutor {
  constructor(private pool: SimulatorPool) {}

  private async executeOnAll<T>(
    operation: (sim: PooledSimulator) => Promise<T>
  ): Promise<BatchResult<T>[]> {
    const simulators = this.pool.getAll();

    const settled = await Promise.allSettled(
      simulators.map(async (sim): Promise<BatchResult<T>> => {
        const start = Date.now();
        this.pool.markActivity(sim.device.udid);
        try {
          const result = await operation(sim);
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            viewport: { w: (sim.device as any).viewport?.width ?? 390, h: (sim.device as any).viewport?.height ?? 844 },
            result,
            timing: Date.now() - start,
          };
        } catch (err) {
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

    return settled.map(r => r.status === 'fulfilled' ? r.value : {
      device: 'unknown',
      deviceId: 'unknown',
      viewport: { w: 0, h: 0 },
      error: 'Promise rejected',
      timing: 0,
    });
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
