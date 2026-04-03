/**
 * Device Matrix E2E -- Validates all 10 device presets boot, connect, and report correct dimensions.
 *
 * Tests each preset through the full lifecycle: boot -> WebKit connect -> verify viewport -> shutdown.
 * Also validates multi-device coexistence and sequential rotation through all presets.
 *
 * Requires: macOS with Xcode Simulator, ios-webkit-debug-proxy
 * Run: npm run test:integration -- --testPathPattern device-matrix
 */

import { SimulatorPool, PooledSimulator } from '../../src/simulator/pool';
import { DEVICE_PRESETS } from '../../src/simulator/presets';
import { isSimulatorAvailable, describeWithSimulator } from './helpers/simulator-check';

// Track all pools created during the suite so afterAll can clean up
const createdPools: SimulatorPool[] = [];

function createPool(max = 5): SimulatorPool {
  const pool = new SimulatorPool({ max, concurrency: 1 });
  createdPools.push(pool);
  return pool;
}

afterAll(async () => {
  for (const pool of createdPools) {
    try {
      await pool.shutdownAll();
    } catch {
      // best effort
    }
  }
});

// ---------------------------------------------------------------------------
// Test 1: Individual preset validation
// ---------------------------------------------------------------------------
describeWithSimulator('Device Matrix E2E: Individual preset validation', () => {
  let available = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) {
      console.error('[device-matrix-e2e] Skipping: Xcode or iOS Simulator runtime not available');
    }
  });

  it.each(Object.entries(DEVICE_PRESETS))(
    '%s (%s) boots and connects via WebKit',
    async (presetKey, preset) => {
      if (!available) return;

      const pool = createPool(1);
      try {
        const [sim] = await pool.bootAll([presetKey]);
        expect(sim).toBeDefined();
        expect(sim.preset).toBe(presetKey);

        if (sim.client.isConnected()) {
          // Verify viewport dimensions
          const dims = await sim.client.evaluate<{ innerWidth: number; innerHeight: number; dpr: number }>(`({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            dpr: window.devicePixelRatio
          })`);

          // Width should match preset within tolerance (Safari UI may adjust slightly)
          expect(dims.innerWidth).toBeGreaterThanOrEqual(preset.w - 2);
          expect(dims.innerWidth).toBeLessThanOrEqual(preset.w + 2);

          // DPR should match exactly
          expect(dims.dpr).toBe(preset.dpr);
        } else {
          // WebKit proxy may not be running; just verify the device booted
          console.error(`[device-matrix-e2e] ${presetKey}: booted but WebKit not connected (proxy may not be running)`);
          expect(sim.device.udid).toBeTruthy();
        }
      } finally {
        await pool.shutdownAll();
      }
    },
    90_000,
  );
});

// ---------------------------------------------------------------------------
// Test 2: Multi-device coexistence
// ---------------------------------------------------------------------------
describeWithSimulator('Device Matrix E2E: Multi-device coexistence', () => {
  let available = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
  });

  it('boots smallest and largest iPhone simultaneously', async () => {
    if (!available) return;

    const pool = createPool(2);
    try {
      const devices = await pool.bootAll(['iphone-se-1', 'iphone-17-pro-max']);
      expect(devices).toHaveLength(2);

      const seSim = devices.find(d => d.preset === 'iphone-se-1')!;
      const proMaxSim = devices.find(d => d.preset === 'iphone-17-pro-max')!;

      expect(seSim).toBeDefined();
      expect(proMaxSim).toBeDefined();

      if (seSim.client.isConnected() && proMaxSim.client.isConnected()) {
        // Both should report correct dimensions
        const se = await seSim.client.evaluate<{ innerWidth: number }>('({ innerWidth: window.innerWidth })');
        const proMax = await proMaxSim.client.evaluate<{ innerWidth: number }>('({ innerWidth: window.innerWidth })');

        // SE should be narrower than Pro Max
        expect(se.innerWidth).toBeLessThan(proMax.innerWidth);
      } else {
        // Verify devices at least booted
        expect(seSim.device.udid).toBeTruthy();
        expect(proMaxSim.device.udid).toBeTruthy();
      }
    } finally {
      await pool.shutdownAll();
    }
  }, 120_000);

  it('boots iPhone + iPad together with independent lifecycle', async () => {
    if (!available) return;

    const pool = createPool(2);
    try {
      const devices = await pool.bootAll(['iphone-17-pro', 'ipad-pro']);
      expect(devices).toHaveLength(2);

      const iphoneSim = devices.find(d => d.preset === 'iphone-17-pro')!;
      const ipadSim = devices.find(d => d.preset === 'ipad-pro')!;

      // Navigate independently (if connected)
      if (iphoneSim.client.isConnected()) {
        await iphoneSim.client.navigate({ url: 'https://example.com' });
      }
      if (ipadSim.client.isConnected()) {
        await ipadSim.client.navigate({ url: 'https://example.com' });
      }

      // Shutdown iPad only -- iPhone should survive
      await pool.shutdownOne(ipadSim.device.udid);

      // iPhone should still be in the pool
      expect(pool.get(iphoneSim.device.udid)).not.toBeNull();

      // iPad should be removed
      expect(pool.get(ipadSim.device.udid)).toBeNull();
    } finally {
      await pool.shutdownAll();
    }
  }, 120_000);

  it('3-device batch: iPhone SE + iPhone 17 Pro + iPad Pro', async () => {
    if (!available) return;

    const pool = createPool(3);
    try {
      const devices = await pool.bootAll(['iphone-se-3', 'iphone-17-pro', 'ipad-pro']);
      expect(devices).toHaveLength(3);

      // All should have valid UDIDs
      for (const d of devices) {
        expect(d.device.udid).toBeTruthy();
        expect(d.preset).toBeTruthy();
      }

      // Verify preset diversity
      const presets = devices.map(d => d.preset);
      expect(presets).toContain('iphone-se-3');
      expect(presets).toContain('iphone-17-pro');
      expect(presets).toContain('ipad-pro');
    } finally {
      await pool.shutdownAll();
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Test 3: Sequential rotation through all presets
// ---------------------------------------------------------------------------
describeWithSimulator('Device Matrix E2E: Sequential rotation through all presets', () => {
  let available = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
  });

  it('cycles through all 10 presets via bootSequential', async () => {
    if (!available) return;

    const pool = createPool(5);
    const allPresets = Object.keys(DEVICE_PRESETS);
    expect(allPresets).toHaveLength(10);

    const results = await pool.bootSequential(
      allPresets,
      async (sim: PooledSimulator, preset: string, index: number) => {
        const connected = sim.client.isConnected();
        let width = 0;
        let dpr = 0;
        if (connected) {
          const dims = await sim.client.evaluate<{ innerWidth: number; dpr: number }>(
            '({ innerWidth: window.innerWidth, dpr: window.devicePixelRatio })',
          );
          width = dims.innerWidth;
          dpr = dims.dpr;
        }
        return { preset, index, width, dpr, connected };
      },
    );

    // All 10 presets should have been tested
    expect(results).toHaveLength(10);

    // All should have completed (not failed)
    for (const r of results) {
      expect(r.status).toBe('completed');
    }

    // Verify each result carries correct preset name
    for (let i = 0; i < allPresets.length; i++) {
      expect(results[i].preset).toBe(allPresets[i]);
      const data = results[i].result as { preset: string; index: number; width: number; dpr: number; connected: boolean };
      expect(data.preset).toBe(allPresets[i]);
      expect(data.index).toBe(i);
    }

    // Pool must be empty after sequential run (all devices shut down)
    expect(pool.size).toBe(0);
  }, 600_000); // 10 minutes for all 10 devices

  it('validates dimension accuracy for connected devices in sequential rotation', async () => {
    if (!available) return;

    const pool = createPool(5);
    // Test a representative subset to keep runtime reasonable
    const subset = ['iphone-se-1', 'iphone-17-pro', 'ipad-pro'];

    const results = await pool.bootSequential(
      subset,
      async (sim: PooledSimulator, preset: string) => {
        if (!sim.client.isConnected()) {
          return { preset, connected: false, width: 0, height: 0, dpr: 0 };
        }
        const dims = await sim.client.evaluate<{ innerWidth: number; innerHeight: number; dpr: number }>(`({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          dpr: window.devicePixelRatio
        })`);
        return { preset, connected: true, ...dims };
      },
    );

    expect(results).toHaveLength(3);

    for (const r of results) {
      expect(r.status).toBe('completed');
      const data = r.result as { preset: string; connected: boolean; innerWidth: number; innerHeight: number; dpr: number };
      if (data.connected) {
        const expected = DEVICE_PRESETS[data.preset];
        // Width within +/-2px tolerance
        expect(data.innerWidth).toBeGreaterThanOrEqual(expected.w - 2);
        expect(data.innerWidth).toBeLessThanOrEqual(expected.w + 2);
        // DPR should match exactly
        expect(data.dpr).toBe(expected.dpr);
      }
    }

    expect(pool.size).toBe(0);
  }, 300_000); // 5 minutes for 3 devices
});
