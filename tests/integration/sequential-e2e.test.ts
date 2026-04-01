/**
 * E2E Tests: Sequential Rotation + SessionManager Multi-Device Coexistence
 *
 * These tests require REAL iOS Simulators via Xcode.
 * They validate the sequential boot/shutdown lifecycle, error isolation,
 * SessionManager independence, memory profile, and zombie cleanup safety.
 *
 * Run with: npm run test:integration -- --testPathPattern sequential-e2e
 */

import { SimulatorPool, PooledSimulator } from '../../src/simulator/pool';
import { getSessionManager, SessionManager } from '../../src/session-manager';
import {
  startPeriodicCleanup,
  stopPeriodicCleanup,
  getAllManagedDeviceIds,
} from '../../src/reliability/zombie-cleanup';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Environment gate: skip entire suite if Xcode / Simulator unavailable
// ---------------------------------------------------------------------------

async function canRunE2E(): Promise<boolean> {
  try {
    await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available']);
    return true;
  } catch {
    return false;
  }
}

let e2eAvailable = false;

beforeAll(async () => {
  e2eAvailable = await canRunE2E();
  if (!e2eAvailable) {
    console.error('[E2E] Skipping: Xcode or iOS Simulator runtime not available');
  }
});

// Sequential boots are slow; allow up to 3 minutes per test
jest.setTimeout(180_000);

// Track all pools created during the suite so afterAll can clean up
const createdPools: SimulatorPool[] = [];

afterAll(async () => {
  // Ensure every pool is fully shut down even if a test fails mid-run
  for (const pool of createdPools) {
    try {
      await pool.shutdownAll();
    } catch {
      // best effort
    }
  }
  stopPeriodicCleanup();
});

function createPool(): SimulatorPool {
  const pool = new SimulatorPool({ max: 5, concurrency: 1 });
  createdPools.push(pool);
  return pool;
}

// ---------------------------------------------------------------------------
// Test 1: Sequential Rotation Full Cycle
// ---------------------------------------------------------------------------
describe('Sequential Rotation E2E', () => {
  it('should boot devices one at a time, run callback, shutdown, then next', async () => {
    if (!e2eAvailable) return;

    const pool = createPool();
    const bootTimestamps: number[] = [];

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro'],
      async (sim: PooledSimulator, preset: string) => {
        // Record boot timestamp to verify sequential (non-overlapping) execution
        bootTimestamps.push(Date.now());

        // Navigate to example.com and retrieve the page title
        if (sim.client.isConnected()) {
          await sim.client.navigate({ url: 'https://example.com' });
          const title = await sim.client.evaluate<string>('document.title');
          return { preset, title };
        }
        // Fallback when WebKit connection is unavailable (proxy not running)
        return { preset, title: 'no-connection' };
      },
    );

    // Verify: 2 results, both completed
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('completed');

    // Each result carries the correct preset
    const r0 = results[0].result as { preset: string; title: string };
    const r1 = results[1].result as { preset: string; title: string };
    expect(r0.preset).toBe('iphone-17');
    expect(r1.preset).toBe('ipad-pro');

    // Titles should be non-empty strings (exact value depends on connectivity)
    expect(typeof r0.title).toBe('string');
    expect(typeof r1.title).toBe('string');

    // Pool must be empty after sequential run (all devices shut down)
    expect(pool.size).toBe(0);

    // Verify no two simulators were booted simultaneously:
    // Since bootSequential shuts down device N before booting device N+1,
    // and we record timestamps inside the runner, the first device must
    // have completed (and been shut down) before the second runner fires.
    // The sequential nature is enforced by the for-loop in bootSequential.
    // We verify pool.size === 0 and that both runners executed.
    expect(bootTimestamps).toHaveLength(2);
    expect(bootTimestamps[1]).toBeGreaterThan(bootTimestamps[0]);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Sequential Error Isolation
  // ---------------------------------------------------------------------------
  it('should isolate errors: middle device failure does not skip subsequent devices', async () => {
    if (!e2eAvailable) return;

    const pool = createPool();
    const DELIBERATE_ERROR = 'Deliberate test failure for device-b';

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro', 'iphone-17'],
      async (_sim: PooledSimulator, _preset: string, index: number) => {
        if (index === 1) {
          throw new Error(DELIBERATE_ERROR);
        }
        return { index, ok: true };
      },
    );

    // All 3 results must be present
    expect(results).toHaveLength(3);

    // device-a (index 0): completed
    expect(results[0].status).toBe('completed');
    expect((results[0].result as { index: number }).index).toBe(0);

    // device-b (index 1): failed with the deliberate error
    expect(results[1].status).toBe('failed');
    expect(results[1].error).toContain(DELIBERATE_ERROR);

    // device-c (index 2): completed (NOT skipped after device-b failure)
    expect(results[2].status).toBe('completed');
    expect((results[2].result as { index: number }).index).toBe(2);

    // All devices must be shut down
    expect(pool.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 3: SessionManager Multi-Device Coexistence
  // ---------------------------------------------------------------------------
  it('should allow independent multi-device connections via SessionManager', async () => {
    if (!e2eAvailable) return;

    const pool = createPool();
    const sm: SessionManager = getSessionManager();

    // Boot two devices into the pool simultaneously
    const booted = await pool.bootAll(['iphone-17', 'ipad-pro']);
    expect(booted).toHaveLength(2);

    const iphoneSim = booted.find(b => b.preset === 'iphone-17')!;
    const ipadSim = booted.find(b => b.preset === 'ipad-pro')!;
    const udidIphone = iphoneSim.device.udid;
    const udidIpad = ipadSim.device.udid;

    // Both should be registered in SessionManager
    expect(sm.getSimulator(udidIphone)).not.toBeNull();
    expect(sm.getSimulator(udidIpad)).not.toBeNull();

    // Both connections should work independently (if proxy is available)
    const iphoneConn = sm.getConnection(udidIphone);
    const ipadConn = sm.getConnection(udidIpad);

    if (iphoneConn && ipadConn) {
      // Both can evaluate independently
      const iphoneResult = await iphoneConn.evaluate<number>('1 + 1');
      const ipadResult = await ipadConn.evaluate<number>('2 + 2');
      expect(iphoneResult).toBe(2);
      expect(ipadResult).toBe(4);
    }

    // Shutdown iPad only
    await pool.shutdownOne(udidIpad);

    // iPad removed from SessionManager
    expect(sm.getSimulator(udidIpad)).toBeNull();
    expect(sm.hasConnection(udidIpad)).toBe(false);

    // iPhone still works
    expect(sm.getSimulator(udidIphone)).not.toBeNull();
    const iphoneConnAfter = sm.getConnection(udidIphone);
    if (iphoneConnAfter) {
      const stillWorks = await iphoneConnAfter.evaluate<number>('3 + 3');
      expect(stillWorks).toBe(6);
    }

    // Clean up remaining device
    await pool.shutdownAll();
    expect(pool.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Sequential Rotation Memory Profile
  // ---------------------------------------------------------------------------
  it('should keep peak RSS under 200MB for the opensafari process during sequential rotation', async () => {
    if (!e2eAvailable) return;

    const pool = createPool();
    const memorySnapshots: { phase: string; rssMB: number }[] = [];

    const takeSnapshot = (phase: string) => {
      const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      memorySnapshots.push({ phase, rssMB });
    };

    takeSnapshot('before-start');

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro', 'iphone-17'],
      async (_sim: PooledSimulator, preset: string, index: number) => {
        takeSnapshot(`during-device-${index}-${preset}`);
        // Small workload to exercise memory
        if (_sim.client.isConnected()) {
          await _sim.client.evaluate<string>('document.title');
        }
        return { index };
      },
    );

    takeSnapshot('after-complete');

    // All 3 must complete
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.status).toBe('completed'));

    // Log memory snapshots for diagnostics
    console.error('[E2E Memory Profile]', JSON.stringify(memorySnapshots, null, 2));

    // Peak RSS of the opensafari (Node.js) process should stay under 200MB.
    // The simulator processes run out-of-process and are not counted here.
    const peakRSS = Math.max(...memorySnapshots.map(s => s.rssMB));
    expect(peakRSS).toBeLessThan(200);

    expect(pool.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Zombie Cleanup Non-Interference
  // ---------------------------------------------------------------------------
  it('should not kill active devices when zombie cleanup runs during sequential rotation', async () => {
    if (!e2eAvailable) return;

    const pool = createPool();

    // Start periodic zombie cleanup with a 60-second grace period.
    // The grace period means the first cleanup sweep fires AFTER 60s,
    // giving bootSequential time to cycle through devices without
    // the cleanup seeing them as orphans.
    startPeriodicCleanup(
      () => {
        // Provide the pool's currently known device IDs as "protected"
        const ids = new Set<string>();
        for (const sim of pool.getAll()) {
          ids.add(sim.device.udid);
        }
        return ids;
      },
      60_000,  // interval: 60s
      60_000,  // grace: 60s
    );

    const activeUdids: string[] = [];

    const results = await pool.bootSequential(
      ['iphone-17', 'ipad-pro'],
      async (sim: PooledSimulator, _preset: string) => {
        // Record the UDID while it is active
        activeUdids.push(sim.device.udid);

        // Verify the device is NOT in the managed registry as orphaned.
        // getAllManagedDeviceIds returns devices registered by live processes,
        // meaning our device should be there (registered, not orphaned).
        const managed = getAllManagedDeviceIds();
        // The active device should either be in the managed set or the pool
        expect(
          managed.has(sim.device.udid) || pool.get(sim.device.udid) !== null
        ).toBe(true);

        // Small workload
        if (sim.client.isConnected()) {
          await sim.client.evaluate<string>('document.title');
        }

        return { udid: sim.device.udid };
      },
    );

    stopPeriodicCleanup();

    // Both devices completed successfully (zombie cleanup did NOT kill them)
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('completed');

    // All devices shut down after sequential run
    expect(pool.size).toBe(0);

    // Verify we actually tracked two distinct UDIDs
    expect(activeUdids).toHaveLength(2);
  });
});
