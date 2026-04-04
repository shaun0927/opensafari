/**
 * Sequential Rotation Stress Tests — Validates device cycling under pressure.
 *
 * Tests rapid device rotation, concurrent boot calls, and cleanup verification.
 * Uses mocks for SimulatorManager to keep tests fast; real simulator integration
 * is covered by sequential-e2e.test.ts.
 */

import { SimulatorPool } from '../../src/simulator/pool';
import { DEVICE_PRESETS } from '../../src/simulator/presets';

// ── Mock SimulatorManager ──
// Intercept boot/shutdown so tests run without real simulators.

let mockBootCount = 0;
let mockShutdownCount = 0;
let mockBootedDevices: Set<string> = new Set();

jest.mock('../../src/simulator/manager', () => {
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      boot: jest.fn().mockImplementation(async (presetOrName: string) => {
        const udid = `mock-udid-${++mockBootCount}`;
        mockBootedDevices.add(udid);
        return {
          udid,
          name: DEVICE_PRESETS[presetOrName]?.name ?? presetOrName,
          state: 'Booted',
        };
      }),
      shutdown: jest.fn().mockImplementation(async (udid: string) => {
        mockShutdownCount++;
        mockBootedDevices.delete(udid);
      }),
      openUrl: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock WebKitClient to avoid real WebSocket connections
jest.mock('../../src/webkit/client', () => {
  return {
    WebKitClient: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
      evaluate: jest.fn().mockResolvedValue('mock-title'),
      navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 100 }),
      setCookies: jest.fn().mockResolvedValue(undefined),
      getCookies: jest.fn().mockResolvedValue([]),
    })),
  };
});

// ── Test Suite ──

describe('Sequential Rotation Stress Tests', () => {
  let pool: SimulatorPool;

  beforeEach(() => {
    mockBootCount = 0;
    mockShutdownCount = 0;
    mockBootedDevices = new Set();
    pool = new SimulatorPool({ max: 10, concurrency: 1 });
    // Bypass resource check since we are using mocks
    pool.checkResources = async () => {};
  });

  afterEach(async () => {
    try { await pool.shutdownAll(); } catch { /* best-effort */ }
  });

  // ── Test 1: Full Preset Rotation ──

  test('should cycle through all 10 presets sequentially without orphaned processes', async () => {
    const allPresets = Object.keys(DEVICE_PRESETS);
    expect(allPresets.length).toBe(10);

    const completedPresets: string[] = [];

    const results = await pool.bootSequential(
      allPresets,
      async (_sim, preset, _index) => {
        completedPresets.push(preset);
        return { preset, ok: true };
      },
    );

    // All 10 should complete
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.status).toBe('completed');
    }

    // Each preset was visited
    expect(completedPresets).toEqual(allPresets);

    // Pool should be empty (all shut down after each step)
    expect(pool.size).toBe(0);

    // No mock devices should remain booted
    expect(mockBootedDevices.size).toBe(0);

    // Boot count should equal shutdown count (no orphans)
    expect(mockBootCount).toBe(10);
    expect(mockShutdownCount).toBe(10);
  }, 30_000);

  // ── Test 2: Rapid Sequential Boot/Shutdown ──

  test('should handle rapid boot-immediate-shutdown cycles (5 iterations)', async () => {
    const presets = ['iphone-17', 'ipad-pro', 'iphone-17-pro', 'iphone-se-3', 'iphone-air'];

    const results = await pool.bootSequential(
      presets,
      async (_sim, preset) => {
        // Minimal work — return immediately
        return { preset, timestamp: Date.now() };
      },
    );

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe('completed');
      expect(r.duration).toBeDefined();
    }

    // All devices shut down
    expect(pool.size).toBe(0);
    expect(mockBootedDevices.size).toBe(0);
  }, 30_000);

  // ── Test 3: Error Isolation in Full Rotation ──

  test('should continue rotation even when middle devices fail', async () => {
    const presets = ['iphone-17', 'ipad-pro', 'iphone-17-pro', 'ipad-air', 'iphone-air'];
    const FAIL_INDICES = [1, 3]; // ipad-pro and ipad-air fail

    const results = await pool.bootSequential(
      presets,
      async (_sim, _preset, index) => {
        if (FAIL_INDICES.includes(index)) {
          throw new Error(`Deliberate failure at index ${index}`);
        }
        return { index, ok: true };
      },
    );

    expect(results).toHaveLength(5);

    // Check each result
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('failed');
    expect(results[1].error).toContain('Deliberate failure');
    expect(results[2].status).toBe('completed');
    expect(results[3].status).toBe('failed');
    expect(results[3].error).toContain('Deliberate failure');
    expect(results[4].status).toBe('completed');

    // All devices cleaned up regardless of errors
    expect(pool.size).toBe(0);
    expect(mockBootedDevices.size).toBe(0);
  }, 30_000);

  // ── Test 4: Post-Rotation Cleanup Verification ──

  test('should leave zero mock-booted devices after full rotation', async () => {
    const presets = ['iphone-17', 'ipad-pro', 'iphone-se-3'];

    await pool.bootSequential(
      presets,
      async (_sim, preset) => {
        // Verify only 1 device is booted at a time
        expect(mockBootedDevices.size).toBe(1);
        return { preset };
      },
    );

    // After rotation: no booted devices
    expect(mockBootedDevices.size).toBe(0);
    expect(pool.size).toBe(0);

    // Total boots = total shutdowns
    expect(mockBootCount).toBe(mockShutdownCount);
  }, 30_000);

  // ── Test 5: Concurrent Pool Instances ──

  test('should allow two pool instances to operate without interference', async () => {
    const pool1 = new SimulatorPool({ max: 5, concurrency: 1 });
    const pool2 = new SimulatorPool({ max: 5, concurrency: 1 });
    pool1.checkResources = async () => {};
    pool2.checkResources = async () => {};

    const presets1 = ['iphone-17', 'ipad-pro'];
    const presets2 = ['iphone-se-3', 'iphone-air'];

    // Run both pools sequentially (not in parallel to avoid port conflicts)
    const results1 = await pool1.bootSequential(
      presets1,
      async (_sim, preset) => ({ pool: 1, preset }),
    );

    const results2 = await pool2.bootSequential(
      presets2,
      async (_sim, preset) => ({ pool: 2, preset }),
    );

    // Both pools completed all devices
    expect(results1).toHaveLength(2);
    expect(results2).toHaveLength(2);
    for (const r of [...results1, ...results2]) {
      expect(r.status).toBe('completed');
    }

    // Pool results are independent
    const r1Values = results1.map(r => (r.result as any).pool);
    const r2Values = results2.map(r => (r.result as any).pool);
    expect(r1Values).toEqual([1, 1]);
    expect(r2Values).toEqual([2, 2]);

    // Cleanup
    await pool1.shutdownAll();
    await pool2.shutdownAll();
  }, 30_000);

  // ── Test 6: Sequential Timing Verification ──

  test('should execute devices in order with non-overlapping timestamps', async () => {
    const timestamps: Array<{ preset: string; start: number; end: number }> = [];

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro', 'iphone-17-pro'],
      async (_sim, preset) => {
        const start = Date.now();
        // Small delay to make timestamps distinguishable
        await new Promise(r => setTimeout(r, 50));
        const end = Date.now();
        timestamps.push({ preset, start, end });
        return { preset };
      },
    );

    expect(results).toHaveLength(3);

    // Verify sequential: each device's start should be after the previous end
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i].start).toBeGreaterThanOrEqual(timestamps[i - 1].end);
    }
  }, 30_000);

  // ── Test 7: Duration Tracking ──

  test('should track duration for each sequential device', async () => {
    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro'],
      async (_sim, preset) => {
        await new Promise(r => setTimeout(r, 100));
        return { preset };
      },
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.duration).toBeGreaterThanOrEqual(50); // At least some measurable time
      expect(r.duration).toBeLessThan(10_000); // Sanity upper bound
    }
  }, 30_000);
});
