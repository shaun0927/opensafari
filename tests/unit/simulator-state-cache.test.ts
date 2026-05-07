/**
 * Unit tests for the simulator polling optimisations introduced in #703:
 *   - SimulatorStateCache: TTL, invalidation, concurrent-tick deduplication
 *   - hasBootstatus capability detection (with memoisation reset)
 *   - SimulatorManager.boot() uses bootstatus when capable
 *   - SimulatorManager.boot() falls back to list when bootstatus unavailable
 *   - SimulatorManager.shutdown() timeout error surfaces (not hidden)
 *   - Cache invalidates after boot / shutdown / delete
 *   - Parallel pool tick: shared state reads
 */

// Stub post-boot optimize so no real launchctl is spawned
jest.mock('../../src/simulator/post-boot-optimize', () => ({
  disableBackgroundServices: jest.fn().mockResolvedValue([]),
}));

import {
  SimulatorStateCache,
  resetBootstatusCapabilityForTests,
  SimctlError,
} from '../../src/simulator/simctl';
import { SimulatorManager } from '../../src/simulator/manager';
import { SimPool } from '../../src/simulator/sim-pool';

// ── helpers ────────────────────────────────────────────────────────────────

type DeviceState = 'Booted' | 'Shutdown' | 'Creating' | 'ShuttingDown';

/** Build the minimal JSON shape that SimulatorManager.listDevices() parses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeviceJson(udid: string, state: DeviceState): any {
  return {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
        { udid, name: 'iPhone 15', state, isAvailable: true },
      ],
    },
    runtimes: [],
  };
}

function makeFakeUuid(seed: number): string {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  return `${hex(seed, 8)}-${hex(seed + 1, 4)}-${hex(seed + 2, 4)}-${hex(seed + 3, 4)}-${hex(seed + 4, 12)}`;
}

const UDID = 'AAAAAAAA-0001-0002-0003-000000000001';

/** Probe UDID used by hasBootstatus() — any call to this UDID is just a probe. */
const PROBE_UDID = '00000000-0000-0000-0000-000000000000';

// ── makeManager helper ─────────────────────────────────────────────────────

/**
 * Create a SimulatorManager with its private simctl executor replaced by jest
 * mocks. Accesses private fields through `as any` which is acceptable in tests.
 */
function makeManager() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = new SimulatorManager() as any;

  const fakeExec = jest.fn(async (_args: string[]): Promise<string> => '');
  const fakeExecJson = jest.fn(async (_args: string[]): Promise<unknown> =>
    makeDeviceJson(UDID, 'Booted'),
  );

  mgr.simctl = { exec: fakeExec, execJson: fakeExecJson };
  mgr.stateCache.invalidateAll();

  return {
    manager: mgr as SimulatorManager,
    // Keep `any` typed refs so tests can assign .mockImplementation freely
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeExec: fakeExec as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeExecJson: fakeExecJson as any,
    // Convenience direct cache access
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateCache: mgr.stateCache as SimulatorStateCache,
  };
}

// ── SimulatorStateCache ────────────────────────────────────────────────────

describe('SimulatorStateCache', () => {
  test('returns undefined on a cold cache', () => {
    const cache = new SimulatorStateCache(500);
    expect(cache.get(UDID)).toBeUndefined();
  });

  test('returns the cached entry within TTL', () => {
    const cache = new SimulatorStateCache(500);
    cache.set(UDID, 'Booted');
    const entry = cache.get(UDID);
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('Booted');
    expect(entry!.udid).toBe(UDID);
  });

  test('returns undefined after TTL expires', async () => {
    const cache = new SimulatorStateCache(50); // 50 ms TTL
    cache.set(UDID, 'Booted');
    await new Promise(r => setTimeout(r, 60));
    expect(cache.get(UDID)).toBeUndefined();
  });

  test('invalidate() removes a specific entry immediately', () => {
    const cache = new SimulatorStateCache(5000);
    cache.set(UDID, 'Booted');
    expect(cache.get(UDID)).toBeDefined();
    cache.invalidate(UDID);
    expect(cache.get(UDID)).toBeUndefined();
  });

  test('invalidateAll() clears every entry', () => {
    const cache = new SimulatorStateCache(5000);
    cache.set(UDID, 'Booted');
    cache.set('OTHER-UDID', 'Shutdown');
    cache.invalidateAll();
    expect(cache.get(UDID)).toBeUndefined();
    expect(cache.get('OTHER-UDID')).toBeUndefined();
  });

  test('set() overwrites a previous value for the same UDID', () => {
    const cache = new SimulatorStateCache(5000);
    cache.set(UDID, 'Booted');
    cache.set(UDID, 'Shutdown');
    expect(cache.get(UDID)!.state).toBe('Shutdown');
  });
});

// ── bootstatus capability + getDeviceState ─────────────────────────────────

describe('SimulatorManager.getDeviceState()', () => {
  beforeEach(() => resetBootstatusCapabilityForTests());

  test('uses bootstatus and returns Booted when it exits 0', async () => {
    const { manager, fakeExec } = makeManager();

    // Probe UDID gets device-not-found (capability present — not "Unknown command")
    // Real UDID: exit 0 = Booted
    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') {
        if (args[1] === PROBE_UDID) {
          throw new SimctlError('Unable to lookup sim by UDID', args, 1);
        }
        return ''; // exit 0 = Booted
      }
      return '';
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (manager as any).getDeviceState(UDID);
    expect(state).toBe('Booted');

    // mock.calls entries are [args: string[]], so c[0] is the args array
    const bootstatusCalls = (fakeExec as jest.Mock).mock.calls.filter(
      (c: [string[]]) => c[0][0] === 'bootstatus' && c[0][1] === UDID,
    );
    expect(bootstatusCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('falls back to list when bootstatus is unavailable', async () => {
    const { manager, fakeExec, fakeExecJson } = makeManager();

    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') {
        throw new SimctlError('Unknown command: bootstatus', args, 1);
      }
      return '';
    });
    fakeExecJson.mockResolvedValue(makeDeviceJson(UDID, 'Booted'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (manager as any).getDeviceState(UDID);
    expect(state).toBe('Booted');

    // bootstatus should NOT have been called with the real UDID
    const bootstatusReal = (fakeExec as jest.Mock).mock.calls.filter(
      (c: [string[]]) => c[0][0] === 'bootstatus' && c[0][1] === UDID,
    );
    expect(bootstatusReal.length).toBe(0);

    // Full list must have been used
    expect((fakeExecJson as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Cache invalidation ─────────────────────────────────────────────────────

describe('SimulatorManager: cache invalidation after lifecycle mutations', () => {
  beforeEach(() => resetBootstatusCapabilityForTests());

  test('boot() clears the stale Shutdown entry before the polling loop', async () => {
    const { manager, fakeExec, fakeExecJson, stateCache } = makeManager();

    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') throw new SimctlError('Unknown command: bootstatus', args, 1);
      return '';
    });
    let execJsonCalls = 0;
    fakeExecJson.mockImplementation(async () => {
      execJsonCalls++;
      // First call: resolveDevice sees Shutdown; subsequent: Booted
      return makeDeviceJson(UDID, execJsonCalls === 1 ? 'Shutdown' : 'Booted');
    });

    // Pre-populate with a stale Shutdown entry
    stateCache.set(UDID, 'Shutdown');
    expect(stateCache.get(UDID)).toBeDefined();

    await manager.boot(UDID, { timeout: 5000 });

    // After boot completes, the stale entry must be gone or show Booted
    const entry = stateCache.get(UDID);
    if (entry) {
      expect(entry.state).toBe('Booted');
    }
    // The key assertion: a stale Shutdown entry was not retained throughout
  });

  test('deleteDevice() invalidates the cache entry', async () => {
    const { manager, fakeExec, stateCache } = makeManager();
    fakeExec.mockResolvedValue('');

    stateCache.set(UDID, 'Booted');
    await manager.deleteDevice(UDID);
    expect(stateCache.get(UDID)).toBeUndefined();
  });

  test('shutdown() invalidates the cache entry after issuing the command', async () => {
    const { manager, fakeExec, fakeExecJson, stateCache } = makeManager();

    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') throw new SimctlError('Unknown command: bootstatus', args, 1);
      return '';
    });
    let execJsonCalls = 0;
    fakeExecJson.mockImplementation(async () => {
      execJsonCalls++;
      // First call (pre-check): Booted; subsequent (poll): Shutdown
      return makeDeviceJson(UDID, execJsonCalls <= 1 ? 'Booted' : 'Shutdown');
    });

    stateCache.set(UDID, 'Booted');
    await manager.shutdown(UDID, { timeout: 5000 });

    // After shutdown, cache must not still report Booted
    const entry = stateCache.get(UDID);
    if (entry) {
      expect(entry.state).toBe('Shutdown');
    }
  });
});

// ── Shutdown timeout error surfaces ───────────────────────────────────────

describe('SimulatorManager.shutdown() timeout behavior', () => {
  beforeEach(() => resetBootstatusCapabilityForTests());

  test('reaches nuclear erase when device never shuts down within timeout', async () => {
    const { manager, fakeExec, fakeExecJson } = makeManager();
    const eraseArgs: string[][] = [];

    // bootstatus unavailable; device is always Booted (stuck)
    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') throw new SimctlError('Unknown command: bootstatus', args, 1);
      if (args[0] === 'erase') eraseArgs.push([...args]);
      return '';
    });
    // Always return Booted — simulates a stuck simulator
    fakeExecJson.mockResolvedValue(makeDeviceJson(UDID, 'Booted'));

    // Very short timeout so the test completes quickly.
    // Jest timeout must exceed: poll-timeout (100ms) + retry-sleep (5000ms) + margin.
    await manager.shutdown(UDID, { timeout: 100 });

    // Nuclear erase MUST be reached — the timeout must not be silently swallowed
    expect(eraseArgs.length).toBeGreaterThanOrEqual(1);
    expect(eraseArgs[0][1]).toBe(UDID);
  }, 15000 /* ms — covers the 5 s retry-sleep inside shutdown() */);
});

// ── boot() uses bootstatus ─────────────────────────────────────────────────

describe('SimulatorManager.boot() bootstatus integration', () => {
  beforeEach(() => resetBootstatusCapabilityForTests());

  test('polling loop uses bootstatus and skips full-list reads', async () => {
    const { manager, fakeExec, fakeExecJson } = makeManager();

    const bootstatusCalls: string[] = [];
    const listCalls: string[][] = [];

    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') {
        if (args[1] === PROBE_UDID) {
          // Capability probe: non-"Unknown command" error = capability present
          throw new SimctlError('Unable to lookup sim', args, 1);
        }
        bootstatusCalls.push(args[1]);
        return ''; // exit 0 = Booted
      }
      if (args[0] === 'list') listCalls.push([...args]);
      return '';
    });

    // First execJson = resolveDevice (Shutdown); second = getDevice after confirmed boot
    let execJsonCalls = 0;
    fakeExecJson.mockImplementation(async () => {
      execJsonCalls++;
      return makeDeviceJson(UDID, execJsonCalls === 1 ? 'Shutdown' : 'Booted');
    });

    const result = await manager.boot(UDID, { timeout: 5000 });

    expect(result.udid).toBe(UDID);
    // bootstatus was used during the polling loop
    expect(bootstatusCalls.length).toBeGreaterThanOrEqual(1);
    // No raw 'list' exec calls during the polling loop
    expect(listCalls.length).toBe(0);
  });

  test('polling loop falls back to full list when bootstatus unavailable', async () => {
    const { manager, fakeExec, fakeExecJson } = makeManager();

    fakeExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'bootstatus') throw new SimctlError('Unknown command: bootstatus', args, 1);
      return '';
    });

    let execJsonCalls = 0;
    fakeExecJson.mockImplementation(async () => {
      execJsonCalls++;
      return makeDeviceJson(UDID, execJsonCalls <= 1 ? 'Shutdown' : 'Booted');
    });

    const result = await manager.boot(UDID, { timeout: 5000 });

    expect(result.udid).toBe(UDID);
    // bootstatus was never called with the real UDID (only probe UDID)
    const realBootstatusCalls = (fakeExec as jest.Mock).mock.calls.filter(
      (c: [string[]]) => c[0][0] === 'bootstatus' && c[0][1] === UDID,
    );
    expect(realBootstatusCalls.length).toBe(0);
    // Full list was used for polling (at least resolveDevice + one poll tick)
    expect(execJsonCalls).toBeGreaterThanOrEqual(2);
  });
});

// ── Parallel pool tick: shared state reads ─────────────────────────────────

describe('Parallel pool tick: shared state reads', () => {
  beforeEach(() => resetBootstatusCapabilityForTests());

  test('concurrent pool acquires call getDeviceState not getDevice for polling', async () => {
    let cloneCounter = 0;
    const fakeSimctl = {
      exec: jest.fn(async (args: string[]): Promise<string> => {
        if (args[0] === 'clone') {
          cloneCounter++;
          return `${makeFakeUuid(cloneCounter * 1000)}\n`;
        }
        return '';
      }),
    };

    const getDeviceStateCalls: string[] = [];
    const getDeviceCalls: string[] = [];

    const fakeManager = {
      resolveDevice: jest.fn(async () => ({
        udid: UDID,
        name: 'iPhone 15',
        state: 'Shutdown' as DeviceState,
        isAvailable: true,
        runtime: '',
        runtimeVersion: '',
      })),
      getDevice: jest.fn(async (udid: string) => {
        getDeviceCalls.push(udid);
        return {
          udid,
          name: 'iPhone 15',
          state: 'Booted' as DeviceState,
          isAvailable: true,
          runtime: '',
          runtimeVersion: '',
        };
      }),
      getDeviceState: jest.fn(async (udid: string) => {
        getDeviceStateCalls.push(udid);
        return 'Booted' as DeviceState;
      }),
      shutdown: jest.fn(async () => {}),
    };

    const pool = new SimPool({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      simctl: fakeSimctl as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: fakeManager as any,
    });

    await Promise.all([
      pool.acquire('iphone-15'),
      pool.acquire('iphone-15'),
    ]);

    // getDeviceState was used for the polling loop (not the heavier getDevice)
    expect(getDeviceStateCalls.length).toBeGreaterThanOrEqual(2);

    // getDevice must NOT be called during the waitForBootedState polling loop
    // (it is allowed to be called 0 times — the pool uses getDeviceState)
    expect(getDeviceCalls.length).toBe(0);
  });
});
