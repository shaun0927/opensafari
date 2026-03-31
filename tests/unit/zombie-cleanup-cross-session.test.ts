/**
 * Issue #263 Verification: Zombie cleanup cross-session safety
 *
 * Verifies that cleanupOrphanedSimulators (via cleanupZombieProcesses) correctly
 * protects simulators owned by other live sessions while still cleaning up
 * truly orphaned devices. Also verifies registry helpers and isProcessAlive.
 */

import * as fs from 'fs';
import * as child_process from 'child_process';
import {
  registerManagedDevices,
  addManagedDevice,
  unregisterManagedDevices,
  getAllManagedDeviceIds,
  cleanupZombieProcesses,
  type DeviceRegistry,
} from '../../src/reliability/zombie-cleanup';

// ---------------------------------------------------------------------------
// Mock fs so no real files are read/written
// ---------------------------------------------------------------------------
jest.mock('fs');

const fsMock = fs as jest.Mocked<typeof fs>;

// ---------------------------------------------------------------------------
// Mock child_process with a factory that attaches util.promisify.custom so
// that promisify(execFile) inside zombie-cleanup.ts resolves to { stdout, stderr }
// rather than just the raw first callback argument.
// ---------------------------------------------------------------------------

// Holds the implementation for the current test — updated by mockExecFile().
let _execFileImpl: ((...args: any[]) => void) | null = null;

jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require('util');

  // The base mock function delegates to whatever _execFileImpl is set to.
  const execFileMock = jest.fn((...args: any[]) => {
    if (_execFileImpl) _execFileImpl(...args);
  });

  // Attach promisify.custom so that promisify(execFileMock) returns
  // a function that resolves to { stdout, stderr } just like the real execFile.
  (execFileMock as any)[promisify.custom] = (...callArgs: any[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // Append a Node-style (err, stdout, stderr) callback.
      execFileMock(...callArgs, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  return {
    ...jest.requireActual('child_process'),
    execFile: execFileMock,
  };
});

const cpMock = child_process as jest.Mocked<typeof child_process>;

// ---------------------------------------------------------------------------
// Helpers for setting up fake registry state
// ---------------------------------------------------------------------------

function makeRegistryJson(registry: DeviceRegistry): string {
  return JSON.stringify(registry, null, 2);
}

/**
 * Configure the fs mock to serve the given registry and be a no-op for writes.
 */
function setupFsForRegistry(registry: DeviceRegistry): void {
  jest.clearAllMocks();
  // Reset execFile impl so it doesn't carry state between tests.
  _execFileImpl = null;

  fsMock.mkdirSync.mockReturnValue(undefined as any);
  (fsMock.existsSync as jest.Mock).mockReturnValue(true);
  fsMock.writeFileSync.mockReturnValue(undefined);
  fsMock.unlinkSync.mockReturnValue(undefined);
  fsMock.rmdirSync.mockReturnValue(undefined);

  (fsMock.readFileSync as jest.Mock).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('info')) {
      return JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    }
    return makeRegistryJson(registry);
  });
}

/**
 * Set the execFile mock to call back with (null, stdout, '').
 * The promisify.custom shim defined in the factory will resolve to { stdout }.
 */
function mockExecFile(stdout: string): void {
  _execFileImpl = (...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback(null, stdout, '');
  };
}

/**
 * Set the execFile mock to call back with an error.
 */
function mockExecFileError(err: Error): void {
  _execFileImpl = (...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback(err, '', '');
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a minimal simctl JSON payload
// ---------------------------------------------------------------------------

function makeSimctlJson(
  devices: Array<{ udid: string; state: string; name: string }>,
): string {
  const runtime = devices.map(d => ({ udid: d.udid, state: d.state, name: d.name }));
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17': runtime } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Zombie cleanup: cross-session safety (#263)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _execFileImpl = null;
  });

  // ── isProcessAlive semantics ─────────────────────────────────────────────

  describe('isProcessAlive semantics (via getAllManagedDeviceIds pruning)', () => {
    it('treats the current process PID as alive', () => {
      const registry: DeviceRegistry = {
        [String(process.pid)]: {
          udids: ['UDID-OWN-1'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      const managed = getAllManagedDeviceIds();
      expect(managed.has('UDID-OWN-1')).toBe(true);
    });

    it('treats a non-existent PID as dead and prunes its entry', () => {
      const deadPid = 9999999;
      let isDead = false;
      try { process.kill(deadPid, 0); } catch (err: any) { isDead = err.code === 'ESRCH'; }
      if (!isDead) return; // Skip if OS considers that PID alive

      const registry: DeviceRegistry = {
        [String(deadPid)]: {
          udids: ['UDID-STALE-1', 'UDID-STALE-2'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      const managed = getAllManagedDeviceIds();
      expect(managed.has('UDID-STALE-1')).toBe(false);
      expect(managed.has('UDID-STALE-2')).toBe(false);
    });
  });

  // ── Cross-session protection ─────────────────────────────────────────────

  describe('cleanupZombieProcesses does NOT kill simulators owned by another live session', () => {
    it('protects UDIDs registered by another alive PID', async () => {
      // Use the current process PID so isProcessAlive returns true.
      const otherPid = process.pid;
      const otherUdid = 'UDID-OTHER-SESSION-1';

      const registry: DeviceRegistry = {
        [String(otherPid)]: {
          udids: [otherUdid],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      mockExecFile(makeSimctlJson([{ udid: otherUdid, state: 'Booted', name: 'Other Session Device' }]));

      const cleaned = await cleanupZombieProcesses(new Set());

      const shutdownCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown') && args[1].includes(otherUdid),
      );
      expect(shutdownCalls).toHaveLength(0);
      expect(cleaned).toBe(0);
    });

    it('protects multiple UDIDs from a live PID', async () => {
      const udid1 = 'UDID-SESSION-A-1';
      const udid2 = 'UDID-SESSION-A-2';

      const registry: DeviceRegistry = {
        [String(process.pid)]: {
          udids: [udid1, udid2],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      mockExecFile(makeSimctlJson([
        { udid: udid1, state: 'Booted', name: 'Device A1' },
        { udid: udid2, state: 'Booted', name: 'Device A2' },
      ]));

      const cleaned = await cleanupZombieProcesses(new Set());

      const shutdownCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown'),
      );
      expect(shutdownCalls).toHaveLength(0);
      expect(cleaned).toBe(0);
    });
  });

  // ── Own-session protection ───────────────────────────────────────────────

  describe('cleanupZombieProcesses does NOT kill simulators in knownDeviceIds', () => {
    it('protects own-session devices passed via knownDeviceIds', async () => {
      const ownUdid = 'UDID-OWN-SESSION';
      setupFsForRegistry({});

      mockExecFile(makeSimctlJson([{ udid: ownUdid, state: 'Booted', name: 'Own Device' }]));

      const cleaned = await cleanupZombieProcesses(new Set([ownUdid]));

      const shutdownCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown') && args[1].includes(ownUdid),
      );
      expect(shutdownCalls).toHaveLength(0);
      expect(cleaned).toBe(0);
    });
  });

  // ── Orphan cleanup ───────────────────────────────────────────────────────

  describe('cleanupZombieProcesses DOES kill orphaned simulators', () => {
    it('shuts down a booted simulator with no owning session', async () => {
      const orphanUdid = 'UDID-ORPHAN-NO-OWNER';
      const deadPid = 9999999;
      const registry: DeviceRegistry = {
        [String(deadPid)]: {
          udids: [orphanUdid],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      // First call returns device list; second call (shutdown) returns empty stdout.
      let callNum = 0;
      _execFileImpl = (...args: any[]) => {
        callNum++;
        const cb = args[args.length - 1];
        if (callNum === 1) {
          cb(null, makeSimctlJson([{ udid: orphanUdid, state: 'Booted', name: 'Orphan Device' }]), '');
        } else {
          cb(null, '', '');
        }
      };

      const cleaned = await cleanupZombieProcesses(new Set());
      expect(cleaned).toBe(1);

      const shutdownCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown') && args[1].includes(orphanUdid),
      );
      expect(shutdownCalls).toHaveLength(1);
    });

    it('shuts down orphan but not protected device in same list', async () => {
      const orphanUdid = 'UDID-ORPHAN';
      const protectedUdid = 'UDID-PROTECTED';
      const deadPid = 9999999;
      const registry: DeviceRegistry = {
        [String(deadPid)]: {
          udids: [orphanUdid],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      let callNum = 0;
      _execFileImpl = (...args: any[]) => {
        callNum++;
        const cb = args[args.length - 1];
        if (callNum === 1) {
          cb(null, makeSimctlJson([
            { udid: orphanUdid, state: 'Booted', name: 'Orphan' },
            { udid: protectedUdid, state: 'Booted', name: 'Protected' },
          ]), '');
        } else {
          cb(null, '', '');
        }
      };

      const cleaned = await cleanupZombieProcesses(new Set([protectedUdid]));
      expect(cleaned).toBe(1);

      const allCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls;
      const orphanShutdown = allCalls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown') && args[1].includes(orphanUdid),
      );
      const protectedShutdown = allCalls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown') && args[1].includes(protectedUdid),
      );
      expect(orphanShutdown).toHaveLength(1);
      expect(protectedShutdown).toHaveLength(0);
    });

    it('cleans up device whose owning PID is dead (stale registry entry)', async () => {
      const deadPid = 9999999;
      let isDead = false;
      try { process.kill(deadPid, 0); } catch (err: any) { isDead = err.code === 'ESRCH'; }
      if (!isDead) return;

      const staleUdid = 'UDID-STALE-DEAD-PID';
      const registry: DeviceRegistry = {
        [String(deadPid)]: {
          udids: [staleUdid],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      let callNum = 0;
      _execFileImpl = (...args: any[]) => {
        callNum++;
        const cb = args[args.length - 1];
        if (callNum === 1) {
          cb(null, makeSimctlJson([{ udid: staleUdid, state: 'Booted', name: 'Stale Device' }]), '');
        } else {
          cb(null, '', '');
        }
      };

      const cleaned = await cleanupZombieProcesses(new Set());
      expect(cleaned).toBe(1);
    });
  });

  // ── Registry multi-session merging ───────────────────────────────────────

  describe('Global device registry tracks session ownership', () => {
    it('merges UDIDs from multiple alive PIDs into a single protected set', () => {
      const registry: DeviceRegistry = {
        [String(process.pid)]: {
          udids: ['UDID-MERGE-1', 'UDID-MERGE-2'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      const managed = getAllManagedDeviceIds();
      expect(managed.has('UDID-MERGE-1')).toBe(true);
      expect(managed.has('UDID-MERGE-2')).toBe(true);
    });

    it('registerManagedDevices writes entry for current PID', () => {
      setupFsForRegistry({});
      registerManagedDevices(['UDID-REG-1', 'UDID-REG-2']);

      const writeCalls = fsMock.writeFileSync.mock.calls;
      expect(writeCalls.length).toBeGreaterThan(0);
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;
      expect(written[String(process.pid)]).toBeDefined();
      expect(written[String(process.pid)].udids).toEqual(['UDID-REG-1', 'UDID-REG-2']);
    });

    it('addManagedDevice appends without overwriting existing devices', () => {
      const existing: DeviceRegistry = {
        [String(process.pid)]: {
          udids: ['UDID-EXISTING'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(existing);

      addManagedDevice('UDID-NEW');

      const writeCalls = fsMock.writeFileSync.mock.calls;
      expect(writeCalls.length).toBeGreaterThan(0);
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;
      const udids = written[String(process.pid)].udids;
      expect(udids).toContain('UDID-EXISTING');
      expect(udids).toContain('UDID-NEW');
    });

    it('addManagedDevice does not duplicate an already-registered UDID', () => {
      const existing: DeviceRegistry = {
        [String(process.pid)]: {
          udids: ['UDID-DUP'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(existing);

      addManagedDevice('UDID-DUP');

      const writeCalls = fsMock.writeFileSync.mock.calls;
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;
      const udids = written[String(process.pid)].udids;
      expect(udids.filter((u: string) => u === 'UDID-DUP')).toHaveLength(1);
    });

    it('unregisterManagedDevices removes the current PID entry', () => {
      const existing: DeviceRegistry = {
        [String(process.pid)]: {
          udids: ['UDID-TO-REMOVE'],
          startedAt: new Date().toISOString(),
        },
        '99': {
          udids: ['UDID-OTHER'],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(existing);

      unregisterManagedDevices();

      const writeCalls = fsMock.writeFileSync.mock.calls;
      expect(writeCalls.length).toBeGreaterThan(0);
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;
      expect(written[String(process.pid)]).toBeUndefined();
      // Other PIDs are untouched
      expect(written['99']).toBeDefined();
    });
  });

  // ── Parallel session independence ────────────────────────────────────────

  describe('Parallel sessions operate independently without interference', () => {
    it('each session only removes its own PID on unregister', () => {
      const otherPid = 12345;
      const registry: DeviceRegistry = {
        [String(process.pid)]: { udids: ['UDID-SELF'], startedAt: new Date().toISOString() },
        [String(otherPid)]: { udids: ['UDID-OTHER'], startedAt: new Date().toISOString() },
      };
      setupFsForRegistry(registry);

      unregisterManagedDevices();

      const writeCalls = fsMock.writeFileSync.mock.calls;
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;

      expect(written[String(process.pid)]).toBeUndefined();
      expect(written[String(otherPid)]).toBeDefined();
      expect(written[String(otherPid)].udids).toContain('UDID-OTHER');
    });

    it('registerManagedDevices replaces only own entry, not other sessions', () => {
      const otherPid = 12345;
      const registry: DeviceRegistry = {
        [String(otherPid)]: { udids: ['UDID-OTHER-SESSION'], startedAt: new Date().toISOString() },
      };
      setupFsForRegistry(registry);

      registerManagedDevices(['UDID-SELF-NEW']);

      const writeCalls = fsMock.writeFileSync.mock.calls;
      const lastWrite = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastWrite[1] as string) as DeviceRegistry;

      expect(written[String(process.pid)]).toBeDefined();
      expect(written[String(process.pid)].udids).toContain('UDID-SELF-NEW');
      expect(written[String(otherPid)]).toBeDefined();
      expect(written[String(otherPid)].udids).toContain('UDID-OTHER-SESSION');
    });

    it('cleanup does not touch devices protected by any live session', async () => {
      const session1Udid = 'UDID-SES1';
      const session2Udid = 'UDID-SES2';

      const registry: DeviceRegistry = {
        [String(process.pid)]: {
          udids: [session1Udid, session2Udid],
          startedAt: new Date().toISOString(),
        },
      };
      setupFsForRegistry(registry);

      mockExecFile(makeSimctlJson([
        { udid: session1Udid, state: 'Booted', name: 'Session 1 Device' },
        { udid: session2Udid, state: 'Booted', name: 'Session 2 Device' },
      ]));

      const cleaned = await cleanupZombieProcesses(new Set());
      expect(cleaned).toBe(0);
    });
  });

  // ── Detection mode ───────────────────────────────────────────────────────

  describe('cleanupZombieProcesses detection mode', () => {
    it('returns a number without killing anything when called without knownDeviceIds', async () => {
      setupFsForRegistry({});
      mockExecFile('1234\n5678\n');

      const count = await cleanupZombieProcesses();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);

      // No simctl shutdown should be called in detection mode
      const shutdownCalls = (cpMock.execFile as unknown as jest.Mock).mock.calls.filter(
        (args: any[]) => Array.isArray(args[1]) && args[1].includes('shutdown'),
      );
      expect(shutdownCalls).toHaveLength(0);
    });

    it('returns 0 when no CoreSimulator processes found', async () => {
      setupFsForRegistry({});
      mockExecFileError(new Error('no processes found'));

      const count = await cleanupZombieProcesses();
      expect(count).toBe(0);
    });
  });
});
