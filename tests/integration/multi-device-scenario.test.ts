import { ScenarioRunner, TestScenario } from '../../src/orchestration/scenario-runner';
import { CrossDeviceAssert } from '../../src/orchestration/cross-device-assert';
import { StepBarrier } from '../../src/orchestration/step-barrier';
import { SimulatorPool, PooledSimulator } from '../../src/simulator/pool';

// --- Mock helpers ---

function createMockSim(
  preset: string,
  udid: string,
  clientOverrides?: Record<string, unknown>,
): PooledSimulator {
  return {
    device: { udid, name: preset, state: 'Booted' } as any,
    client: {
      navigate: jest.fn().mockResolvedValue({ url: 'https://example.com', status: 200 }),
      click: jest.fn().mockResolvedValue(undefined),
      type: jest.fn().mockResolvedValue(undefined),
      scroll: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(true),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
      ...clientOverrides,
    } as any,
    preset,
    bootedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function createMockPool(sims: PooledSimulator[]): SimulatorPool {
  return { getAll: jest.fn().mockReturnValue(sims) } as unknown as SimulatorPool;
}

// --- Integration Tests ---

describe('Multi-Device Scenario Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('full pipeline: 3-step scenario with navigation, interaction, and assertion on 2 devices', () => {
    it('should run navigate, click, and assert on both devices with all steps passing', async () => {
      const iphone15 = createMockSim('iphone15', 'udid-iphone15');
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro');
      const pool = createMockPool([iphone15, ipadPro]);
      const runner = new ScenarioRunner(pool);

      const scenario: TestScenario = {
        name: 'multi-device-pipeline',
        steps: [
          { action: 'navigate', value: 'https://example.com/app' },
          { action: 'click', target: '#submit-btn' },
          { action: 'assert', assertion: 'document.title === "Success"' },
        ],
      };

      const result = await runner.run(scenario);

      // Overall scenario passes
      expect(result.name).toBe('multi-device-pipeline');
      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(result.summary).toBe('3/3 steps passed on 2 device(s)');
      expect(result.duration).toBeGreaterThanOrEqual(0);

      // Verify per-step, per-device result structure
      for (const step of result.steps) {
        expect(step.devices).toHaveLength(2);
        expect(step.passed).toBe(true);
        for (const deviceResult of step.devices) {
          expect(deviceResult.passed).toBe(true);
          expect(deviceResult.timing).toBeGreaterThanOrEqual(0);
          expect(['iphone15', 'ipad-pro']).toContain(deviceResult.device);
          expect(['udid-iphone15', 'udid-ipad-pro']).toContain(deviceResult.deviceId);
        }
      }

      // Step 0: navigate
      expect(result.steps[0].action).toBe('navigate');
      expect(iphone15.client.navigate).toHaveBeenCalledWith({
        url: 'https://example.com/app',
        waitUntil: 'load',
        timeout: undefined,
      });
      expect(ipadPro.client.navigate).toHaveBeenCalledWith({
        url: 'https://example.com/app',
        waitUntil: 'load',
        timeout: undefined,
      });

      // Step 1: click
      expect(result.steps[1].action).toBe('click');
      expect(iphone15.client.click).toHaveBeenCalledWith('#submit-btn');
      expect(ipadPro.client.click).toHaveBeenCalledWith('#submit-btn');

      // Step 2: assert
      expect(result.steps[2].action).toBe('assert');
      expect(iphone15.client.evaluate).toHaveBeenCalledWith('document.title === "Success"');
      expect(ipadPro.client.evaluate).toHaveBeenCalledWith('document.title === "Success"');
    });
  });

  describe('scenario + cross-device assertion pipeline', () => {
    it('should run a scenario then verify a condition across both devices', async () => {
      const iphone15 = createMockSim('iphone15', 'udid-iphone15', {
        evaluate: jest.fn().mockResolvedValue(true),
      });
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro', {
        evaluate: jest.fn().mockResolvedValue(true),
      });
      const pool = createMockPool([iphone15, ipadPro]);

      // Phase 1: Run scenario
      const runner = new ScenarioRunner(pool);
      const scenario: TestScenario = {
        name: 'pre-assert-scenario',
        steps: [
          { action: 'navigate', value: 'https://example.com/dashboard' },
          { action: 'click', target: '#load-data' },
        ],
      };

      const scenarioResult = await runner.run(scenario);
      expect(scenarioResult.passed).toBe(true);
      expect(scenarioResult.steps).toHaveLength(2);

      // Phase 2: Cross-device assertion
      const asserter = new CrossDeviceAssert(pool);
      const assertResult = await asserter.assertAll({
        check: 'custom',
        assertion: 'document.querySelector("#data-table") !== null',
      });

      expect(assertResult.passed).toBe(true);
      expect(assertResult.results).toHaveLength(2);
      expect(assertResult.summary).toBe('2/2 devices passed');

      // Verify both devices are represented
      const deviceNames = assertResult.results.map((r) => r.device).sort();
      expect(deviceNames).toEqual(['ipad-pro', 'iphone15']);

      for (const deviceAssert of assertResult.results) {
        expect(deviceAssert.passed).toBe(true);
        expect(deviceAssert.actual).toBe(true);
      }
    });

    it('should report per-device pass/fail when one device fails assertion', async () => {
      const iphone15 = createMockSim('iphone15', 'udid-iphone15', {
        evaluate: jest.fn().mockResolvedValue(true),
      });
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro', {
        evaluate: jest.fn().mockResolvedValue(false),
      });
      const pool = createMockPool([iphone15, ipadPro]);

      // Run scenario first
      const runner = new ScenarioRunner(pool);
      const scenario: TestScenario = {
        name: 'partial-assert',
        steps: [{ action: 'navigate', value: 'https://example.com' }],
      };
      await runner.run(scenario);

      // Cross-device assertion where iPad fails
      const asserter = new CrossDeviceAssert(pool);
      const assertResult = await asserter.assertAll({
        check: 'custom',
        assertion: 'document.querySelector(".success") !== null',
      });

      expect(assertResult.passed).toBe(false);
      expect(assertResult.results).toHaveLength(2);
      expect(assertResult.summary).toBe('1/2 devices failed: ipad-pro');

      const iphoneResult = assertResult.results.find((r) => r.device === 'iphone15');
      expect(iphoneResult?.passed).toBe(true);

      const ipadResult = assertResult.results.find((r) => r.device === 'ipad-pro');
      expect(ipadResult?.passed).toBe(false);
    });
  });

  describe('scenario with barrier synchronization', () => {
    it('should synchronize 2 devices at a barrier step before proceeding', async () => {
      const barrier = new StepBarrier();
      const deviceIds = ['udid-iphone15', 'udid-ipad-pro'];

      // Simulate both devices arriving at the barrier concurrently
      const [result1, result2] = await Promise.all([
        barrier.wait('after-login', 'udid-iphone15', deviceIds, { timeout: 5000 }),
        barrier.wait('after-login', 'udid-ipad-pro', deviceIds, { timeout: 5000 }),
      ]);

      // Both devices should have arrived
      expect(result1.allArrived).toBe(true);
      expect(result1.stepName).toBe('after-login');
      expect(result1.arrivedDevices).toContain('udid-iphone15');
      expect(result1.arrivedDevices).toContain('udid-ipad-pro');
      expect(result1.missingDevices).toHaveLength(0);
      expect(result1.waitTime).toBeGreaterThanOrEqual(0);

      expect(result2.allArrived).toBe(true);
      expect(result2.stepName).toBe('after-login');
      expect(result2.arrivedDevices).toContain('udid-iphone15');
      expect(result2.arrivedDevices).toContain('udid-ipad-pro');
      expect(result2.missingDevices).toHaveLength(0);

      // Verify barrier status after completion
      const status = barrier.getStatus('after-login');
      // After all arrived, status still shows the barrier
      if (status) {
        expect(status.arrivedCount).toBe(2);
        expect(status.expectedCount).toBe(2);
      }
    });

    it('should integrate barrier with scenario runner for coordinated steps', async () => {
      const barrier = new StepBarrier();
      const iphone15 = createMockSim('iphone15', 'udid-iphone15');
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro');
      const pool = createMockPool([iphone15, ipadPro]);
      const runner = new ScenarioRunner(pool);

      // Step 1: Run navigation scenario on both devices
      const navScenario: TestScenario = {
        name: 'barrier-nav',
        steps: [{ action: 'navigate', value: 'https://example.com/collab' }],
      };
      const navResult = await runner.run(navScenario);
      expect(navResult.passed).toBe(true);

      // Step 2: Both devices synchronize at barrier
      const deviceIds = ['udid-iphone15', 'udid-ipad-pro'];
      const [barrierResult1, barrierResult2] = await Promise.all([
        barrier.wait('nav-complete', deviceIds[0], deviceIds, { timeout: 5000 }),
        barrier.wait('nav-complete', deviceIds[1], deviceIds, { timeout: 5000 }),
      ]);

      expect(barrierResult1.allArrived).toBe(true);
      expect(barrierResult2.allArrived).toBe(true);

      // Step 3: Continue with interaction scenario after barrier
      const interactScenario: TestScenario = {
        name: 'barrier-interact',
        steps: [
          { action: 'click', target: '#collab-edit' },
          { action: 'assert', assertion: 'document.querySelector("#editor").contentEditable === "true"' },
        ],
      };
      const interactResult = await runner.run(interactScenario);
      expect(interactResult.passed).toBe(true);
      expect(interactResult.steps).toHaveLength(2);

      // Clean up
      barrier.clearAll();
    });
  });

  describe('mixed results: one device fails mid-scenario while other succeeds', () => {
    it('should report per-device pass/fail and continue through all steps', async () => {
      const iphone15 = createMockSim('iphone15', 'udid-iphone15', {
        // iPhone click fails (element not found on mobile layout)
        click: jest.fn().mockRejectedValue(new Error('Element #desktop-menu not found')),
      });
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro');
      const pool = createMockPool([iphone15, ipadPro]);
      const runner = new ScenarioRunner(pool);

      const scenario: TestScenario = {
        name: 'mixed-device-results',
        steps: [
          { action: 'navigate', value: 'https://example.com/responsive' },
          { action: 'click', target: '#desktop-menu' },
          { action: 'assert', assertion: 'document.title === "Menu Page"' },
        ],
      };

      const result = await runner.run(scenario);

      // Overall scenario should fail because one device had a failure
      expect(result.passed).toBe(false);
      expect(result.steps).toHaveLength(3);

      // Step 0 (navigate): both pass
      expect(result.steps[0].passed).toBe(true);
      expect(result.steps[0].devices).toHaveLength(2);
      for (const d of result.steps[0].devices) {
        expect(d.passed).toBe(true);
      }

      // Step 1 (click): iPhone fails, iPad passes
      expect(result.steps[1].passed).toBe(false);
      const iphoneClick = result.steps[1].devices.find((d) => d.device === 'iphone15');
      expect(iphoneClick?.passed).toBe(false);
      expect(iphoneClick?.error).toBe('Element #desktop-menu not found');
      const ipadClick = result.steps[1].devices.find((d) => d.device === 'ipad-pro');
      expect(ipadClick?.passed).toBe(true);

      // Step 2 (assert): still executes despite step 1 failure
      expect(result.steps[2].devices).toHaveLength(2);
    });

    it('should show divergent state via cross-device assert after mixed scenario', async () => {
      // iPhone evaluate returns false (broken state), iPad returns true (success state)
      const iphone15 = createMockSim('iphone15', 'udid-iphone15', {
        click: jest.fn().mockRejectedValue(new Error('Click failed on mobile')),
        evaluate: jest.fn().mockResolvedValue(false),
      });
      const ipadPro = createMockSim('ipad-pro', 'udid-ipad-pro', {
        evaluate: jest.fn().mockResolvedValue(true),
      });
      const pool = createMockPool([iphone15, ipadPro]);

      // Phase 1: Run scenario that produces divergent state
      const runner = new ScenarioRunner(pool);
      const scenario: TestScenario = {
        name: 'divergent-state',
        steps: [
          { action: 'navigate', value: 'https://example.com/form' },
          { action: 'click', target: '#submit' },
        ],
      };

      const scenarioResult = await runner.run(scenario);
      expect(scenarioResult.passed).toBe(false);

      // Phase 2: Cross-device assert reveals divergent state
      const asserter = new CrossDeviceAssert(pool);
      const assertResult = await asserter.assertAll({
        check: 'custom',
        assertion: 'document.querySelector(".confirmation") !== null',
      });

      expect(assertResult.passed).toBe(false);
      expect(assertResult.results).toHaveLength(2);

      // iPhone is in broken state
      const iphoneAssert = assertResult.results.find((r) => r.device === 'iphone15');
      expect(iphoneAssert?.passed).toBe(false);
      expect(iphoneAssert?.actual).toBe(false);

      // iPad is in success state
      const ipadAssert = assertResult.results.find((r) => r.device === 'ipad-pro');
      expect(ipadAssert?.passed).toBe(true);
      expect(ipadAssert?.actual).toBe(true);

      // Summary reflects the divergence
      expect(assertResult.summary).toBe('1/2 devices failed: iphone15');
    });
  });
});
