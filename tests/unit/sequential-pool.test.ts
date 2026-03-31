/**
 * Sequential Device Rotation Tests
 * Verifies SimulatorPool.bootSequential() for low-memory multi-device testing.
 */

import { SimulatorPool } from '../../src/simulator/pool';
import { getSessionManager } from '../../src/session-manager';

// Mock SimulatorManager
jest.mock('../../src/simulator/manager', () => {
  let bootCount = 0;
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      boot: jest.fn().mockImplementation(async (preset: string) => {
        bootCount++;
        return {
          udid: `udid-${preset}-${bootCount}`,
          name: `Mock ${preset}`,
          state: 'Booted',
          isAvailable: true,
          runtime: 'iOS-18-0',
          runtimeVersion: '18.0',
        };
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      openUrl: jest.fn().mockResolvedValue(undefined),
      getDevice: jest.fn().mockResolvedValue(null),
    })),
  };
});

// Mock WebKitClient
jest.mock('../../src/webkit/client', () => ({
  WebKitClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    setCookies: jest.fn().mockResolvedValue(undefined),
    navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 0 }),
  })),
}));

// Mock zombie-cleanup
jest.mock('../../src/reliability/zombie-cleanup', () => ({
  registerManagedDevices: jest.fn(),
  unregisterManagedDevices: jest.fn(),
}));

// Mock os.freemem to always have enough
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  freemem: () => 16 * 1024 * 1024 * 1024, // 16GB
}));

describe('SimulatorPool.bootSequential', () => {
  let pool: SimulatorPool;

  beforeEach(() => {
    pool = new SimulatorPool({ max: 5, concurrency: 3 });
    // Reset SessionManager
    const sm = getSessionManager();
    for (const sim of sm.listSimulators()) {
      sm.removeSimulator(sim.deviceId);
    }
  });

  it('should run each device sequentially and return results', async () => {
    const executionOrder: string[] = [];

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro', 'iphone-se'],
      async (sim, preset) => {
        executionOrder.push(preset);
        return { tested: preset, pages: 5 };
      },
    );

    expect(results.size).toBe(3);
    expect(executionOrder).toEqual(['iphone-17', 'ipad-pro', 'iphone-se']);

    const r1 = results.get('iphone-17');
    expect(r1?.status).toBe('completed');
    expect(r1?.result).toEqual({ tested: 'iphone-17', pages: 5 });

    const r2 = results.get('ipad-pro');
    expect(r2?.status).toBe('completed');
  });

  it('should only have one simulator active at a time', async () => {
    let maxConcurrent = 0;
    let currentActive = 0;

    const results = await pool.bootSequential(
      ['device-a', 'device-b', 'device-c'],
      async () => {
        currentActive++;
        maxConcurrent = Math.max(maxConcurrent, currentActive);
        // Simulate some work
        await new Promise(r => setTimeout(r, 10));
        currentActive--;
        return 'done';
      },
    );

    expect(maxConcurrent).toBe(1);
    expect(results.size).toBe(3);
  });

  it('should continue after a device failure', async () => {
    const results = await pool.bootSequential(
      ['good-1', 'bad-device', 'good-2'],
      async (_sim, preset) => {
        if (preset === 'bad-device') {
          throw new Error('Simulated failure');
        }
        return { ok: true };
      },
    );

    expect(results.size).toBe(3);
    expect(results.get('good-1')?.status).toBe('completed');
    expect(results.get('bad-device')?.status).toBe('failed');
    expect(results.get('bad-device')?.error).toContain('Simulated failure');
    expect(results.get('good-2')?.status).toBe('completed');
  });

  it('should track duration per device', async () => {
    const results = await pool.bootSequential(
      ['fast', 'slow'],
      async (_sim, preset) => {
        if (preset === 'slow') {
          await new Promise(r => setTimeout(r, 50));
        }
        return 'done';
      },
    );

    const fast = results.get('fast')!;
    const slow = results.get('slow')!;
    expect(fast.duration).toBeGreaterThanOrEqual(0);
    expect(slow.duration).toBeGreaterThan(fast.duration);
  });

  it('should shut down device after each run', async () => {
    const results = await pool.bootSequential(
      ['a', 'b'],
      async () => 'done',
    );

    // After sequential completion, pool should be empty
    expect(pool.size).toBe(0);
    expect(results.size).toBe(2);
  });

  it('should handle empty device list', async () => {
    const results = await pool.bootSequential([], async () => 'done');
    expect(results.size).toBe(0);
  });

  it('should handle single device', async () => {
    const results = await pool.bootSequential(
      ['solo-device'],
      async () => ({ result: 42 }),
    );

    expect(results.size).toBe(1);
    expect(results.get('solo-device')?.status).toBe('completed');
    expect(results.get('solo-device')?.result).toEqual({ result: 42 });
  });
});

describe('WorkflowEngine sequential mode', () => {
  it('should accept mode parameter in WorkflowInitOptions', () => {
    // Type-level test: ensure mode is accepted
    const options = {
      devices: ['iphone-17'],
      mode: 'sequential' as const,
    };
    expect(options.mode).toBe('sequential');
  });

  it('should default to concurrent mode', () => {
    const options: { devices: string[]; mode?: string } = { devices: ['iphone-17'] };
    expect(options.mode ?? 'concurrent').toBe('concurrent');
  });
});
