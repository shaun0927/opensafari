import { ScenarioRunner, TestScenario } from '../../src/orchestration/scenario-runner';
import { SimulatorPool, PooledSimulator } from '../../src/simulator/pool';

// --- Mock helpers ---

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    navigate: jest.fn().mockResolvedValue({ url: 'https://example.com', status: 200 }),
    click: jest.fn().mockResolvedValue(undefined),
    type: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn().mockResolvedValue(undefined),
    waitFor: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(true),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
    ...overrides,
  };
}

function createMockSim(preset: string, udid: string, clientOverrides?: Record<string, unknown>): PooledSimulator {
  return {
    device: { udid, name: preset, state: 'Booted' } as any,
    client: createMockClient(clientOverrides) as any,
    preset,
    bootedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function createMockPool(sims: PooledSimulator[]): SimulatorPool {
  return {
    getAll: jest.fn().mockReturnValue(sims),
  } as unknown as SimulatorPool;
}

// --- Tests ---

describe('ScenarioRunner', () => {
  const sim1 = createMockSim('iphone14', 'udid-1');
  const sim2 = createMockSim('ipad-pro', 'udid-2');
  const pool = createMockPool([sim1, sim2]);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('executes a 3-step scenario (navigate, click, assert) on 2 devices — all pass', async () => {
    const runner = new ScenarioRunner(pool);
    const scenario: TestScenario = {
      name: 'login-flow',
      steps: [
        { action: 'navigate', value: 'https://example.com' },
        { action: 'click', target: '#login-btn' },
        { action: 'assert', assertion: 'document.title === "Dashboard"' },
      ],
    };

    const result = await runner.run(scenario);

    expect(result.name).toBe('login-flow');
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.summary).toBe('3/3 steps passed on 2 device(s)');

    // Each step ran on both devices
    for (const step of result.steps) {
      expect(step.devices).toHaveLength(2);
      expect(step.passed).toBe(true);
    }

    // Verify mock calls
    expect(sim1.client.navigate).toHaveBeenCalledWith({ url: 'https://example.com', waitUntil: 'load', timeout: undefined });
    expect(sim2.client.navigate).toHaveBeenCalledWith({ url: 'https://example.com', waitUntil: 'load', timeout: undefined });
    expect(sim1.client.click).toHaveBeenCalledWith('#login-btn');
    expect(sim2.client.click).toHaveBeenCalledWith('#login-btn');
    expect(sim1.client.evaluate).toHaveBeenCalledWith('document.title === "Dashboard"');
    expect(sim2.client.evaluate).toHaveBeenCalledWith('document.title === "Dashboard"');
  });

  test('step failure on one device does not stop scenario execution', async () => {
    const failSim = createMockSim('iphone14', 'udid-fail', {
      click: jest.fn().mockRejectedValue(new Error('Element not found')),
    });
    const okSim = createMockSim('ipad-pro', 'udid-ok');
    const mixedPool = createMockPool([failSim, okSim]);
    const runner = new ScenarioRunner(mixedPool);

    const scenario: TestScenario = {
      name: 'mixed-results',
      steps: [
        { action: 'navigate', value: 'https://example.com' },
        { action: 'click', target: '#btn' },
        { action: 'screenshot' },
      ],
    };

    const result = await runner.run(scenario);

    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(3);

    // Step 0 (navigate) should pass on both
    expect(result.steps[0].passed).toBe(true);

    // Step 1 (click) should fail because one device failed
    expect(result.steps[1].passed).toBe(false);
    const failDevice = result.steps[1].devices.find(d => d.device === 'iphone14');
    expect(failDevice?.passed).toBe(false);
    expect(failDevice?.error).toBe('Element not found');
    const okDevice = result.steps[1].devices.find(d => d.device === 'ipad-pro');
    expect(okDevice?.passed).toBe(true);

    // Step 2 (screenshot) still executed despite step 1 failure
    expect(result.steps[2].passed).toBe(true);
    expect(result.steps[2].devices).toHaveLength(2);
  });

  test('assert step returns passed=false when expression evaluates to falsy', async () => {
    const falsySim = createMockSim('iphone14', 'udid-falsy', {
      evaluate: jest.fn().mockResolvedValue(false),
    });
    const truthySim = createMockSim('ipad-pro', 'udid-truthy', {
      evaluate: jest.fn().mockResolvedValue(true),
    });
    const assertPool = createMockPool([falsySim, truthySim]);
    const runner = new ScenarioRunner(assertPool);

    const scenario: TestScenario = {
      name: 'assert-falsy',
      steps: [
        { action: 'assert', assertion: 'document.querySelector(".error") === null' },
      ],
    };

    const result = await runner.run(scenario);

    expect(result.passed).toBe(false);
    expect(result.steps[0].passed).toBe(false);

    const falsyDevice = result.steps[0].devices.find(d => d.device === 'iphone14');
    expect(falsyDevice?.passed).toBe(false);
    expect(falsyDevice?.result).toBe(false);

    const truthyDevice = result.steps[0].devices.find(d => d.device === 'ipad-pro');
    expect(truthyDevice?.passed).toBe(true);
    expect(truthyDevice?.result).toBe(true);
  });

  test('device filtering: step with devices only runs on specified device', async () => {
    const runner = new ScenarioRunner(pool);
    const scenario: TestScenario = {
      name: 'filtered',
      steps: [
        { action: 'click', target: '#mobile-only', devices: ['iphone14'] },
      ],
    };

    const result = await runner.run(scenario);

    expect(result.passed).toBe(true);
    expect(result.steps[0].devices).toHaveLength(1);
    expect(result.steps[0].devices[0].device).toBe('iphone14');

    // Only iphone14 should have received the click
    expect(sim1.client.click).toHaveBeenCalledWith('#mobile-only');
    expect(sim2.client.click).not.toHaveBeenCalled();
  });

  test('empty scenario returns passed=true with 0 steps', async () => {
    const runner = new ScenarioRunner(pool);
    const scenario: TestScenario = {
      name: 'empty',
      steps: [],
    };

    const result = await runner.run(scenario);

    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.summary).toBe('0/0 steps passed on 2 device(s)');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('error in step is caught and reported per-device', async () => {
    const errorSim1 = createMockSim('iphone14', 'udid-err1', {
      navigate: jest.fn().mockRejectedValue(new Error('Network timeout')),
    });
    const errorSim2 = createMockSim('ipad-pro', 'udid-err2', {
      navigate: jest.fn().mockRejectedValue('string error'),
    });
    const errorPool = createMockPool([errorSim1, errorSim2]);
    const runner = new ScenarioRunner(errorPool);

    const scenario: TestScenario = {
      name: 'error-handling',
      steps: [
        { action: 'navigate', value: 'https://broken.example.com' },
      ],
    };

    const result = await runner.run(scenario);

    expect(result.passed).toBe(false);
    expect(result.steps[0].passed).toBe(false);

    const dev1 = result.steps[0].devices.find(d => d.device === 'iphone14');
    expect(dev1?.passed).toBe(false);
    expect(dev1?.error).toBe('Network timeout');
    expect(dev1?.timing).toBeGreaterThanOrEqual(0);

    const dev2 = result.steps[0].devices.find(d => d.device === 'ipad-pro');
    expect(dev2?.passed).toBe(false);
    expect(dev2?.error).toBe('string error');
    expect(dev2?.timing).toBeGreaterThanOrEqual(0);
  });
});
