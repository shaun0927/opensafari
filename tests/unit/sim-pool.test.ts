/**
 * Unit tests for SimPool — clone-based multi-simulator pool from
 * Phase 2B.2 of issue #408.
 */

// Stub the post-boot optimization so tests never try to spawn launchctl
jest.mock('../../src/simulator/post-boot-optimize', () => ({
  disableBackgroundServices: jest.fn().mockResolvedValue([]),
}));

import { SimPool } from '../../src/simulator/sim-pool';
import { disableBackgroundServices } from '../../src/simulator/post-boot-optimize';

const PRESET = 'iphone-se-3';
const MASTER_UDID = 'MASTER-UDID-0000';

function makeFakeUuid(seed: number): string {
  // 8-4-4-4-12 hex digit format so SimPool's regex accepts it
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  return `${hex(seed, 8)}-${hex(seed + 1, 4)}-${hex(seed + 2, 4)}-${hex(seed + 3, 4)}-${hex(seed + 4, 12)}`;
}

function makeStubSimctl() {
  const calls: Array<{ args: string[] }> = [];
  let cloneCounter = 0;
  const exec = jest.fn(async (args: string[]) => {
    calls.push({ args });
    if (args[0] === 'clone') {
      cloneCounter++;
      return `${makeFakeUuid(cloneCounter * 1000)}\n`;
    }
    return '';
  });
  return { exec, calls } as any;
}

function makeStubManager(masterState: 'Booted' | 'Shutdown' = 'Shutdown') {
  const shutdownCalls: string[] = [];
  const getDeviceStates = new Map<string, 'Booted' | 'Shutdown'>();

  const manager = {
    resolveDevice: jest.fn(async (preset: string) => ({
      udid: MASTER_UDID,
      name: preset,
      state: masterState,
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
      runtimeVersion: '17.0',
    })),
    shutdown: jest.fn(async (udid: string) => {
      shutdownCalls.push(udid);
      getDeviceStates.set(udid, 'Shutdown');
    }),
    getDevice: jest.fn(async (udid: string) => {
      // Default: clones become Booted as soon as we check
      const state = getDeviceStates.get(udid) ?? 'Booted';
      return {
        udid,
        name: 'clone',
        state,
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
        runtimeVersion: '17.0',
      };
    }),
    getDeviceState: jest.fn(async (udid: string) => {
      return getDeviceStates.get(udid) ?? 'Booted';
    }),
  } as any;

  return { manager, shutdownCalls };
}

describe('SimPool', () => {
  beforeEach(() => {
    (disableBackgroundServices as jest.Mock).mockClear();
    delete process.env.OPENSAFARI_MAX_SIMULATORS;
  });

  describe('acquire', () => {
    test('clones the master and returns a PooledSimulator', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      const clone = await pool.acquire(PRESET);

      expect(clone.preset).toBe(PRESET);
      expect(clone.udid).toMatch(/^[0-9A-F-]{20,}$/);
      expect(clone.name).toContain('OpenSafari-Pool');
      expect(simctl.calls.map((c: any) => c.args[0])).toEqual(['clone', 'boot']);
      // First arg to clone must be the master UDID
      const cloneCall = simctl.calls.find((c: any) => c.args[0] === 'clone')!;
      expect(cloneCall.args[1]).toBe(MASTER_UDID);
    });

    test('disables background services on the clone', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      await pool.acquire(PRESET);

      expect(disableBackgroundServices).toHaveBeenCalledTimes(1);
    });

    test('skips service disablement when disableServices=false', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager, disableServices: false });

      await pool.acquire(PRESET);

      expect(disableBackgroundServices).not.toHaveBeenCalled();
    });

    test('shuts down a booted master before cloning', async () => {
      const simctl = makeStubSimctl();
      const { manager, shutdownCalls } = makeStubManager('Booted');
      const pool = new SimPool({ simctl, manager });

      await pool.acquire(PRESET);

      expect(shutdownCalls).toContain(MASTER_UDID);
    });

    test('enforces maxClones cap', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager, maxClones: 1 });

      await pool.acquire(PRESET);
      await expect(pool.acquire(PRESET)).rejects.toThrow(/max clones reached/);
    });

    test('deletes the clone and rethrows when boot fails', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();

      const badUuid = makeFakeUuid(9999);
      // Make boot fail; verify delete gets called on cleanup
      simctl.exec = jest.fn(async (args: string[]) => {
        if (args[0] === 'clone') return `${badUuid}\n`;
        if (args[0] === 'boot') throw new Error('boot refused');
        if (args[0] === 'delete') return '';
        return '';
      });

      const pool = new SimPool({ simctl, manager });
      await expect(pool.acquire(PRESET)).rejects.toThrow('boot refused');

      const deleteCalls = (simctl.exec as jest.Mock).mock.calls.filter(
        ([args]: [string[]]) => args[0] === 'delete',
      );
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0][0]).toContain(badUuid);
    });

    test('serializes acquires on the same preset', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      // Slow down the clone operation to force serialization
      const originalExec = simctl.exec;
      let concurrentClones = 0;
      let maxConcurrent = 0;
      simctl.exec = jest.fn(async (args: string[]) => {
        if (args[0] === 'clone') {
          concurrentClones++;
          maxConcurrent = Math.max(maxConcurrent, concurrentClones);
          await new Promise((r) => setTimeout(r, 20));
          concurrentClones--;
        }
        return originalExec(args);
      });

      const pool = new SimPool({ simctl, manager });
      await Promise.all([pool.acquire(PRESET), pool.acquire(PRESET), pool.acquire(PRESET)]);

      expect(maxConcurrent).toBe(1);
    });
  });

  describe('release', () => {
    test('shuts down and deletes the clone by default', async () => {
      const simctl = makeStubSimctl();
      const { manager, shutdownCalls } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      const clone = await pool.acquire(PRESET);
      const released = await pool.release(clone.udid);

      expect(released).toBe(true);
      expect(shutdownCalls).toContain(clone.udid);
      const deleteCalls = simctl.calls.filter((c: any) => c.args[0] === 'delete');
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0].args[1]).toBe(clone.udid);
      expect(pool.size).toBe(0);
    });

    test('keeps the clone alive when keepOnRelease=true', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      const clone = await pool.acquire(PRESET, { keepOnRelease: true });
      await pool.release(clone.udid);

      const deleteCalls = simctl.calls.filter((c: any) => c.args[0] === 'delete');
      expect(deleteCalls.length).toBe(0);
    });

    test('returns false for an unknown UDID', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      await expect(pool.release('unknown-udid')).resolves.toBe(false);
    });
  });

  describe('shutdown', () => {
    test('releases every outstanding clone', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager, maxClones: 5 });

      await pool.acquire(PRESET);
      await pool.acquire(PRESET);
      await pool.acquire(PRESET);
      expect(pool.size).toBe(3);

      await pool.shutdown();
      expect(pool.size).toBe(0);
    });
  });

  describe('list', () => {
    test('returns all outstanding clones with their metadata', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager, maxClones: 5 });

      const a = await pool.acquire(PRESET);
      const b = await pool.acquire(PRESET);

      const list = pool.list();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.udid).sort()).toEqual([a.udid, b.udid].sort());
    });
  });

  // ── Custom master UDID support (Phase 4.2 of #408) ──────────────────────

  describe('custom master UDID', () => {
    const CUSTOM_MASTER = 'CUSTOM-MASTER-1234567890AB';

    function attachCustomMaster(managerStub: any, masterUdid: string) {
      // Extend the stub so `getDevice(masterUdid)` returns a valid device
      // instead of falling back to the default clone stub.
      const originalGetDevice = managerStub.getDevice;
      managerStub.getDevice = jest.fn(async (udid: string) => {
        if (udid === masterUdid) {
          return {
            udid: masterUdid,
            name: 'Pre-Configured Master',
            state: 'Shutdown',
            isAvailable: true,
            runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
            runtimeVersion: '17.0',
          };
        }
        return originalGetDevice(udid);
      });
    }

    test('setMaster + getMaster round-trip', () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      expect(pool.getMaster(PRESET)).toBeNull();
      pool.setMaster(PRESET, CUSTOM_MASTER);
      expect(pool.getMaster(PRESET)).toBe(CUSTOM_MASTER);
      pool.setMaster(PRESET, null);
      expect(pool.getMaster(PRESET)).toBeNull();
    });

    test('acquire uses the registered master instead of preset lookup', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      attachCustomMaster(manager, CUSTOM_MASTER);
      const pool = new SimPool({ simctl, manager });
      pool.setMaster(PRESET, CUSTOM_MASTER);

      await pool.acquire(PRESET);

      // resolveDevice should NOT be called — we went straight to getDevice
      expect(manager.resolveDevice).not.toHaveBeenCalled();
      // Clone source must be our custom master UDID
      const cloneCall = simctl.calls.find((c: any) => c.args[0] === 'clone')!;
      expect(cloneCall.args[1]).toBe(CUSTOM_MASTER);
    });

    test('per-call masterUdid overrides setMaster for that one call', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const OTHER_MASTER = 'OTHER-MASTER-0000000001AB';
      attachCustomMaster(manager, CUSTOM_MASTER);
      attachCustomMaster(manager, OTHER_MASTER);
      const pool = new SimPool({ simctl, manager });
      pool.setMaster(PRESET, CUSTOM_MASTER);

      // Explicit per-call override
      await pool.acquire(PRESET, { masterUdid: OTHER_MASTER });

      const cloneCall = simctl.calls.find((c: any) => c.args[0] === 'clone')!;
      expect(cloneCall.args[1]).toBe(OTHER_MASTER);

      // The pool-level setMaster is untouched for subsequent acquires
      simctl.calls.length = 0;
      await pool.acquire(PRESET);
      const secondClone = simctl.calls.find((c: any) => c.args[0] === 'clone')!;
      expect(secondClone.args[1]).toBe(CUSTOM_MASTER);
    });

    test('acquire without setMaster falls back to preset lookup', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      const pool = new SimPool({ simctl, manager });

      await pool.acquire(PRESET);

      expect(manager.resolveDevice).toHaveBeenCalledWith(PRESET);
      const cloneCall = simctl.calls.find((c: any) => c.args[0] === 'clone')!;
      expect(cloneCall.args[1]).toBe(MASTER_UDID);
    });

    test('throws when the explicit master UDID does not exist', async () => {
      const simctl = makeStubSimctl();
      const { manager } = makeStubManager();
      // getDevice returns null for unknown UDIDs
      manager.getDevice = jest.fn(async (udid: string) => {
        if (udid === 'GHOST-MASTER') return null;
        return { udid, name: 'x', state: 'Booted', isAvailable: true, runtime: '', runtimeVersion: '' };
      });
      const pool = new SimPool({ simctl, manager });
      pool.setMaster(PRESET, 'GHOST-MASTER');

      await expect(pool.acquire(PRESET)).rejects.toThrow(/master UDID "GHOST-MASTER" not found/);
    });

    test('a booted custom master is shut down before cloning', async () => {
      const simctl = makeStubSimctl();
      const { manager, shutdownCalls } = makeStubManager();
      // Custom master is currently Booted
      manager.getDevice = jest.fn(async (udid: string) => {
        if (udid === CUSTOM_MASTER) {
          return {
            udid: CUSTOM_MASTER,
            name: 'Pre-Configured Master',
            state: 'Booted',
            isAvailable: true,
            runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
            runtimeVersion: '17.0',
          };
        }
        // Clones default to Booted
        return {
          udid,
          name: 'clone',
          state: 'Booted',
          isAvailable: true,
          runtime: '',
          runtimeVersion: '',
        };
      });
      const pool = new SimPool({ simctl, manager });
      pool.setMaster(PRESET, CUSTOM_MASTER);

      await pool.acquire(PRESET);

      expect(shutdownCalls).toContain(CUSTOM_MASTER);
    });
  });
});
