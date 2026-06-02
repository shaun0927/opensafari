import { SimulatorPool, PooledSimulator } from '../simulator/pool';
import { ActionTraceRecorder } from '../observability/action-trace';
import { collectAppSessionState } from '../tools/app-state-snapshot';
import { waitForSettle, type SettlePolicy } from '../tools/settle-policy';
import { SimulatorManager } from '../simulator';
import { getAccessibilityBridge } from '../native';
import { getInputBackend } from '../tools/native-input-utils';
import { collectDebugBundle } from '../tools/debug-bundle-collect';

export interface TestScenario {
  name: string;
  steps: TestStep[];
  version?: 1 | 2;
  /** Optional JSON trace artifact path for action-level live-validation evidence. */
  tracePath?: string;
}

export interface TestStep {
  action:
    | 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'assert' | 'screenshot'
    | 'recordState' | 'launchApp' | 'gotoScreen' | 'tapElement' | 'typeElement'
    | 'waitFor' | 'assertElement' | 'collectDebugBundle';
  target?: string;     // CSS selector
  value?: string;      // input value, URL, or scroll direction
  assertion?: string;  // JS expression for assert steps
  devices?: string[];  // subset of device presets (default: all)
  timeout?: number;    // step timeout in ms
  bundleId?: string;
  expectedBundleId?: string;
  query?: SettlePolicy['query'];
  settle?: SettlePolicy;
  condition?: SettlePolicy['condition'];
  context?: 'native' | 'webview' | 'safari' | 'flutter';
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
  beforeState?: unknown;
  afterState?: unknown;
  selectedBackend?: string;
  headless?: boolean;
  verification?: unknown;
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
      const result = await this.executeStep(i, step, scenario.version === 2);
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

  private async executeStep(index: number, step: TestStep, scenarioIsV2: boolean): Promise<StepResult> {
    // Get target simulators (filter by step.devices if specified, else all)
    const allSims = this.pool.getAll();
    const sims = step.devices
      ? allSims.filter(s => step.devices!.includes(s.preset))
      : allSims;

    const deviceResults = await Promise.all(
      sims.map(sim => this.executeOnDevice(sim, step, scenarioIsV2))
    );

    return {
      step: index,
      action: step.action,
      devices: deviceResults,
      passed: deviceResults.every(r => r.passed),
    };
  }

  private async executeOnDevice(sim: PooledSimulator, step: TestStep, scenarioIsV2: boolean): Promise<DeviceStepResult> {
    const start = Date.now();
    let beforeState: unknown;
    let afterState: unknown;
    let verification: unknown;
    const isV2 = isMobileV2Step(step);
    try {
      if (isV2 && !scenarioIsV2) {
        throw new Error(`Scenario action "${step.action}" requires scenario.version === 2`);
      }
      let result: unknown;
      if (isV2) {
        beforeState = await safeState(sim.device.udid, step.expectedBundleId ?? step.bundleId);
      }
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
        case 'recordState': {
          result = beforeState ?? await collectAppSessionState({
            deviceId: sim.device.udid,
            expectedBundleId: step.expectedBundleId ?? step.bundleId,
          });
          break;
        }
        case 'launchApp': {
          if (!step.bundleId) throw new Error('launchApp requires bundleId');
          await new SimulatorManager().launchApp(sim.device.udid, step.bundleId);
          result = { launched: true, bundleId: step.bundleId };
          break;
        }
        case 'gotoScreen': {
          const postconditionQuery = step.settle?.query ?? step.query;
          if (!postconditionQuery) {
            throw new Error('gotoScreen requires a postcondition query');
          }
          if (step.value) {
            await new SimulatorManager().openUrl(sim.device.udid, step.value);
          }
          {
            verification = await waitForSettle(sim.device.udid, {
              ...(step.settle ?? {}),
              query: postconditionQuery,
              condition: step.condition ?? step.settle?.condition ?? 'exists',
              timeoutMs: step.timeout ?? step.settle?.timeoutMs,
            });
            if (!(verification as { met?: boolean }).met) {
              throw new Error('gotoScreen postcondition was not met');
            }
          }
          result = { strategy: step.value ? 'deeplink_postcondition' : 'state_only', value: step.value };
          break;
        }
        case 'waitFor':
        case 'assertElement': {
          verification = await waitForSettle(sim.device.udid, {
            ...(step.settle ?? {}),
            query: step.settle?.query ?? step.query,
            condition: step.condition ?? step.settle?.condition ?? 'exists',
            timeoutMs: step.timeout ?? step.settle?.timeoutMs,
          });
          const met = Boolean((verification as { met?: boolean }).met);
          if (!met) {
            return {
              device: sim.preset,
              deviceId: sim.device.udid,
              passed: false,
              beforeState,
              afterState: await safeState(sim.device.udid, step.expectedBundleId ?? step.bundleId),
              selectedBackend: inferStepBackend(step),
              headless: true,
              verification,
              error: `${step.action} postcondition was not met`,
              timing: Date.now() - start,
            };
          }
          result = verification;
          break;
        }
        case 'tapElement': {
          if (!step.query) throw new Error('tapElement requires query');
          if (!step.settle?.query) throw new Error('tapElement requires a settle.query postcondition');
          const bridge = getAccessibilityBridge();
          const queryResult = await bridge.query(step.query, { deviceId: sim.device.udid, maxResults: 1 });
          const match = queryResult.matches[0];
          if (!match) throw new Error('tapElement query matched no elements');
          let press: { ok: boolean; error?: string };
          try {
            press = await bridge.press(match.path, sim.device.udid);
          } catch (err) {
            press = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          let backend = 'ax-press';
          if (!press.ok) {
            const inputBackend = await getInputBackend(sim.device.udid, sim.client);
            await inputBackend.tap(
              sim.device.udid,
              match.frame.x + match.frame.width / 2,
              match.frame.y + match.frame.height / 2,
            );
            backend = inputBackend.kind;
          }
          verification = await waitForSettle(sim.device.udid, step.settle);
          if (!(verification as { met?: boolean }).met) throw new Error('tapElement postcondition was not met');
          result = { tapped: true, path: match.path, backend, axPress: press };
          break;
        }
        case 'typeElement': {
          if (!step.query) throw new Error('typeElement requires query');
          if (step.value === undefined) throw new Error('typeElement requires value');
          if (!step.settle?.query) throw new Error('typeElement requires a settle.query postcondition');
          const bridge = getAccessibilityBridge();
          const queryResult = await bridge.query(step.query, { deviceId: sim.device.udid, maxResults: 1 });
          const match = queryResult.matches[0];
          if (!match) throw new Error('typeElement query matched no elements');
          let focus: { ok: boolean; error?: string };
          try {
            focus = await bridge.press(match.path, sim.device.udid);
          } catch (err) {
            focus = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          const backend = await getInputBackend(sim.device.udid, sim.client);
          await backend.typeText(sim.device.udid, step.value);
          verification = await waitForSettle(sim.device.udid, step.settle);
          if (!(verification as { met?: boolean }).met) throw new Error('typeElement postcondition was not met');
          result = { typed: true, path: match.path, length: step.value.length, backend: backend.kind, focus };
          break;
        }
        case 'collectDebugBundle': {
          result = await collectDebugBundle({
            deviceId: sim.device.udid,
            bundleId: step.bundleId ?? step.expectedBundleId,
          });
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
      if (isV2) {
        afterState = await safeState(sim.device.udid, step.expectedBundleId ?? step.bundleId);
      }
      return {
        device: sim.preset,
        deviceId: sim.device.udid,
        passed: true,
        result,
        beforeState,
        afterState,
        selectedBackend: isV2 ? inferStepBackend(step) : undefined,
        headless: isV2 ? inferStepBackend(step) !== 'applescript' : undefined,
        verification,
        timing: Date.now() - start,
      };
    } catch (err) {
      return {
        device: sim.preset,
        deviceId: sim.device.udid,
        passed: false,
        beforeState,
        afterState: isV2 ? await safeState(sim.device.udid, step.expectedBundleId ?? step.bundleId) : undefined,
        selectedBackend: isV2 ? inferStepBackend(step) : undefined,
        headless: isV2 ? inferStepBackend(step) !== 'applescript' : undefined,
        verification,
        error: err instanceof Error ? err.message : String(err),
        timing: Date.now() - start,
      };
    }
  }
}

function isMobileV2Step(step: TestStep): boolean {
  return [
    'recordState',
    'launchApp',
    'gotoScreen',
    'tapElement',
    'typeElement',
    'waitFor',
    'assertElement',
    'collectDebugBundle',
  ].includes(step.action);
}


function inferStepBackend(step: TestStep): string {
  if (step.context === 'webview' || step.context === 'safari') return 'webkit';
  if (step.context === 'flutter') return 'flutter-vm';
  if (['waitFor', 'assertElement', 'recordState'].includes(step.action)) return 'ax';
  return 'semantic-mobile';
}

async function safeState(deviceId: string, expectedBundleId?: string): Promise<unknown> {
  try {
    return await collectAppSessionState({
      deviceId,
      expectedBundleId,
      includeFlutter: true,
      maxVisibleNodes: 10,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
