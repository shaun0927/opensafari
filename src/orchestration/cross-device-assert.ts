import { SimulatorPool, PooledSimulator } from '../simulator/pool';

export type AssertionCheck = 'visible' | 'exists' | 'text_matches' | 'custom';

export interface AssertionOptions {
  assertion?: string;  // JS expression returning truthy (for 'custom')
  selector?: string;   // element to check
  check: AssertionCheck;
  expected?: string;   // for text_matches
  includeScreenshot?: boolean; // capture screenshot from each device
}

export interface DeviceAssertionResult {
  device: string;
  deviceId: string;
  passed: boolean;
  actual?: unknown;
  error?: string;
  screenshot?: string; // base64-encoded screenshot when includeScreenshot is true
}

export interface CrossDeviceAssertionResult {
  passed: boolean;
  results: DeviceAssertionResult[];
  summary: string; // e.g. "3/3 devices passed" or "1/3 devices failed: iPhone SE"
}

export class CrossDeviceAssert {
  constructor(private pool: SimulatorPool) {}

  async assertAll(options: AssertionOptions): Promise<CrossDeviceAssertionResult> {
    const simulators = this.pool.getAll();
    if (simulators.length === 0) {
      return { passed: false, results: [], summary: '0 devices available' };
    }

    const results: DeviceAssertionResult[] = await Promise.all(
      simulators.map(async (sim) => {
        try {
          const result = await this.runCheck(sim, options);
          return result;
        } catch (err) {
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            passed: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    const passedCount = results.filter(r => r.passed).length;
    const failedDevices = results.filter(r => !r.passed).map(r => r.device);
    const passed = failedDevices.length === 0;
    const summary = passed
      ? `${passedCount}/${results.length} devices passed`
      : `${failedDevices.length}/${results.length} devices failed: ${failedDevices.join(', ')}`;

    return { passed, results, summary };
  }

  private async runCheck(sim: PooledSimulator, options: AssertionOptions): Promise<DeviceAssertionResult> {
    const base = { device: sim.preset, deviceId: sim.device.udid };

    let result: DeviceAssertionResult;

    switch (options.check) {
      case 'visible': {
        if (!options.selector) {
          return { ...base, passed: false, error: 'selector is required for visible check' };
        }
        const safeSelector = JSON.stringify(options.selector);
        const expression = `(() => { const el = document.querySelector(${safeSelector}); if (!el) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; return el.offsetParent !== null || s.position === 'fixed' || s.position === 'sticky'; })()`;
        const actual = await sim.client.evaluate<boolean>(expression);
        result = { ...base, passed: !!actual, actual };
        break;
      }

      case 'exists': {
        if (!options.selector) {
          return { ...base, passed: false, error: 'selector is required for exists check' };
        }
        const safeSelector = JSON.stringify(options.selector);
        const expression = `document.querySelector(${safeSelector}) !== null`;
        const actual = await sim.client.evaluate<boolean>(expression);
        result = { ...base, passed: !!actual, actual };
        break;
      }

      case 'text_matches': {
        if (!options.selector) {
          return { ...base, passed: false, error: 'selector is required for text_matches check' };
        }
        if (options.expected === undefined) {
          return { ...base, passed: false, error: 'expected is required for text_matches check' };
        }
        const safeSelector = JSON.stringify(options.selector);
        const expression = `(() => { const el = document.querySelector(${safeSelector}); return el ? el.textContent : null; })()`;
        const actual = await sim.client.evaluate<string | null>(expression);
        const passed = actual === options.expected;
        result = { ...base, passed, actual };
        break;
      }

      case 'custom': {
        if (!options.assertion) {
          return { ...base, passed: false, error: 'assertion is required for custom check' };
        }
        const actual = await sim.client.evaluate<unknown>(options.assertion);
        result = { ...base, passed: !!actual, actual };
        break;
      }

      default:
        return { ...base, passed: false, error: `Unknown check type: ${options.check}` };
    }

    // Capture screenshot if requested
    if (options.includeScreenshot) {
      try {
        const buffer = await sim.client.screenshot();
        result.screenshot = buffer.toString('base64');
      } catch (err) {
        // Screenshot failure should not fail the assertion itself
        console.error(`Screenshot capture failed for ${sim.preset}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }
}
