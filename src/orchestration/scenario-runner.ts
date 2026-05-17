import { SimulatorPool, PooledSimulator } from '../simulator/pool';
import { ActionTraceRecorder } from '../observability/action-trace';

export interface TestScenario {
  name: string;
  steps: TestStep[];
  /** Optional JSON trace artifact path for action-level live-validation evidence. */
  tracePath?: string;
}

export interface TestStep {
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'assert' | 'screenshot';
  target?: string;     // CSS selector
  value?: string;      // input value, URL, or scroll direction
  assertion?: string;  // JS expression for assert steps
  devices?: string[];  // subset of device presets (default: all)
  timeout?: number;    // step timeout in ms
}

export interface StepResult {
  step: number;
  action: string;
  devices: DeviceStepResult[];
  passed: boolean;
}

export interface DeviceStepResult {
  device: string;
  deviceId: string;
  passed: boolean;
  result?: unknown;
  error?: string;
  timing: number;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  duration: number;
  summary: string; // e.g. "3/3 steps passed on 2 devices"
}

export class ScenarioRunner {
  constructor(private pool: SimulatorPool) {}

  async run(scenario: TestScenario): Promise<ScenarioResult> {
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const trace = scenario.tracePath ? new ActionTraceRecorder(scenario.name) : null;
    let allPassed = true;

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const result = await this.executeStep(i, step);
      for (const device of result.devices) {
        trace?.record({
          action: `${step.action}:${i}`,
          status: device.passed ? 'passed' : 'failed',
          context: step.action === 'navigate' || step.action === 'assert' ? 'webkit' : 'orchestration',
          deviceId: device.deviceId,
          startedAtMs: startTime + Math.max(0, Date.now() - startTime - device.timing),
          endedAtMs: startTime + Math.max(0, Date.now() - startTime),
          timeoutMs: step.timeout,
          error: device.error,
          metadata: { device: device.device, result: device.result },
        });
      }
      stepResults.push(result);
      if (!result.passed) {
        allPassed = false;
        // Continue executing remaining steps even on failure
      }
    }

    if (trace && scenario.tracePath) {
      await trace.write(scenario.tracePath);
    }

    const duration = Date.now() - startTime;
    const passedSteps = stepResults.filter(s => s.passed).length;
    const totalDevices = this.pool.getAll().length;
    const summary = `${passedSteps}/${stepResults.length} steps passed on ${totalDevices} device(s)`;

    return {
      name: scenario.name,
      passed: allPassed,
      steps: stepResults,
      duration,
      summary,
    };
  }

  private async executeStep(index: number, step: TestStep): Promise<StepResult> {
    // Get target simulators (filter by step.devices if specified, else all)
    const allSims = this.pool.getAll();
    const sims = step.devices
      ? allSims.filter(s => step.devices!.includes(s.preset))
      : allSims;

    const deviceResults = await Promise.all(
      sims.map(sim => this.executeOnDevice(sim, step))
    );

    return {
      step: index,
      action: step.action,
      devices: deviceResults,
      passed: deviceResults.every(r => r.passed),
    };
  }

  private async executeOnDevice(sim: PooledSimulator, step: TestStep): Promise<DeviceStepResult> {
    const start = Date.now();
    try {
      let result: unknown;
      switch (step.action) {
        case 'navigate':
          result = await sim.client.navigate({ url: step.value!, waitUntil: 'load', timeout: step.timeout });
          break;
        case 'click':
          await sim.client.click(step.target!);
          result = 'clicked';
          break;
        case 'type':
          await sim.client.type(step.target!, step.value!);
          result = 'typed';
          break;
        case 'scroll':
          await sim.client.scroll(step.value as 'up' | 'down', 300);
          result = 'scrolled';
          break;
        case 'wait':
          await sim.client.waitFor(step.target!, { timeout: step.timeout ?? 5000 });
          result = 'found';
          break;
        case 'assert': {
          const evalResult = await sim.client.evaluate(step.assertion!);
          const passed = Boolean(evalResult);
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            passed,
            result: evalResult,
            timing: Date.now() - start,
          };
        }
        case 'screenshot': {
          const buf = await sim.client.screenshot();
          result = `screenshot:${buf.length}bytes`;
          break;
        }
        default:
          return {
            device: sim.preset,
            deviceId: sim.device.udid,
            passed: false,
            error: `Unknown action: ${step.action}`,
            timing: Date.now() - start,
          };
      }
      return {
        device: sim.preset,
        deviceId: sim.device.udid,
        passed: true,
        result,
        timing: Date.now() - start,
      };
    } catch (err) {
      return {
        device: sim.preset,
        deviceId: sim.device.udid,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        timing: Date.now() - start,
      };
    }
  }
}
