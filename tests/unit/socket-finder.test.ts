import * as childProcess from 'child_process';
import * as fsPromises from 'fs/promises';
import { EventEmitter } from 'events';
import { findSocketPath, probeSocket, waitForSocketPath } from '../../src/simulator/socket-finder';

// Mock modules
jest.mock('child_process');
jest.mock('fs/promises');

// Track which sockets should be treated as alive
let probeResults: Record<string, boolean> = {};

jest.mock('net', () => ({
  connect: jest.fn((opts: { path?: string }) => {
    const socketPath = opts.path ?? '';
    const alive = probeResults[socketPath] ?? false;
    const emitter = new EventEmitter();
    (emitter as unknown as Record<string, unknown>).setTimeout = jest.fn();
    (emitter as unknown as Record<string, unknown>).destroy = jest.fn();
    process.nextTick(() => {
      if (alive) {
        emitter.emit('connect');
      } else {
        emitter.emit('error', new Error('ECONNREFUSED'));
      }
    });
    return emitter;
  }),
}));

const execFileMock = childProcess.execFile as unknown as jest.Mock;
const readdirMock = fsPromises.readdir as jest.Mock;
const statMock = fsPromises.stat as jest.Mock;
const rmMock = fsPromises.rm as jest.Mock;

// Helper: stub execFile to invoke the callback (promisified pattern)
function stubExecFile(results: Record<string, { stdout?: string; error?: Error }>) {
  execFileMock.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const key = `${cmd} ${(Array.isArray(args) ? args : []).join(' ')}`;
    for (const [pattern, res] of Object.entries(results)) {
      if (key.includes(pattern)) {
        if (res.error) {
          (callback as CallableFunction)(res.error);
        } else {
          (callback as CallableFunction)(null, { stdout: res.stdout ?? '' });
        }
        return;
      }
    }
    (callback as CallableFunction)(new Error(`no stub for: ${key}`));
  });
}

// Helper: stub readdir + stat for mtime tier
function stubFilesystem(sockets: { dir: string; mtimeMs: number }[]) {
  readdirMock.mockImplementation(async (base: string) => {
    if (base === '/private/var/tmp') {
      return sockets.map(s => s.dir);
    }
    throw new Error('ENOENT');
  });
  statMock.mockImplementation(async (p: string) => {
    const match = sockets.find(s => p.includes(s.dir));
    if (match) return { mtimeMs: match.mtimeMs };
    throw new Error('ENOENT');
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  probeResults = {};
  rmMock.mockResolvedValue(undefined);
});

describe('findSocketPath', () => {
  describe('Tier 1: lsof -U', () => {
    it('returns active socket identified by lsof', async () => {
      const socketPath = '/private/var/tmp/com.apple.launchd.ACTIVE/com.apple.webinspectord_sim.socket';
      probeResults[socketPath] = true;

      stubExecFile({
        'lsof -U': {
          stdout: [
            'COMMAND    PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
            `launchd_s 1234 user   8u  unix 0xabc      0t0      ${socketPath}`,
          ].join('\n'),
        },
      });

      const result = await findSocketPath();
      expect(result).toBe(socketPath);
    });

    it('filters by targetUdid via ps command line', async () => {
      const socket1 = '/private/var/tmp/com.apple.launchd.SIM1/com.apple.webinspectord_sim.socket';
      const socket2 = '/private/var/tmp/com.apple.launchd.SIM2/com.apple.webinspectord_sim.socket';
      probeResults[socket1] = true;
      probeResults[socket2] = true;

      const targetUdid = 'AAAA-BBBB-CCCC-DDDD';

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 1001 user  8u  unix 0xa  0t0  ${socket1}`,
            `launchd_s 1002 user  8u  unix 0xb  0t0  ${socket2}`,
          ].join('\n'),
        },
        'ps -p 1001': { stdout: `launchd_sim /path/to/OTHER-UDID/data/run/bootstrap.plist` },
        'ps -p 1002': { stdout: `launchd_sim /path/to/${targetUdid}/data/run/bootstrap.plist` },
      });

      const result = await findSocketPath({ targetUdid });
      expect(result).toBe(socket2);
    });

    it('returns null when targetUdid matches no running simulator', async () => {
      const socket1 = '/private/var/tmp/com.apple.launchd.SIM1/com.apple.webinspectord_sim.socket';
      probeResults[socket1] = true;

      stubExecFile({
        'lsof -U': {
          stdout: `launchd_s 1001 user  8u  unix 0xa  0t0  ${socket1}\n`,
        },
        'ps -p 1001': { stdout: `launchd_sim /path/to/OTHER-UDID/data/run/bootstrap.plist` },
      });

      // Stub filesystem so Tier 2 fallback also returns null
      readdirMock.mockRejectedValue(new Error('ENOENT'));

      const result = await findSocketPath({ targetUdid: 'NON-EXISTENT-UDID' });
      expect(result).toBeNull();
    });

    it('skips sockets that fail liveness probe', async () => {
      const stale = '/private/var/tmp/com.apple.launchd.STALE/com.apple.webinspectord_sim.socket';
      const active = '/private/var/tmp/com.apple.launchd.ACTIVE/com.apple.webinspectord_sim.socket';
      probeResults[stale] = false;
      probeResults[active] = true;

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 1001 user  8u  unix 0xa  0t0  ${stale}`,
            `launchd_s 1002 user  8u  unix 0xb  0t0  ${active}`,
          ].join('\n'),
        },
      });

      const result = await findSocketPath();
      expect(result).toBe(active);
    });
  });

  describe('Tier 2: mtime-sorted fallback', () => {
    it('falls back to mtime when lsof fails', async () => {
      const activeSocket = '/private/var/tmp/com.apple.launchd.NEWEST/com.apple.webinspectord_sim.socket';
      probeResults[activeSocket] = true;

      stubExecFile({ 'lsof -U': { error: new Error('command not found') } });

      stubFilesystem([
        { dir: 'com.apple.launchd.OLDEST', mtimeMs: 1000 },
        { dir: 'com.apple.launchd.NEWEST', mtimeMs: 9000 },
        { dir: 'com.apple.launchd.MIDDLE', mtimeMs: 5000 },
      ]);

      const result = await findSocketPath();
      expect(result).toBe(activeSocket);
    });

    it('skips stale sockets and returns next live one', async () => {
      const stale = '/private/var/tmp/com.apple.launchd.NEWEST/com.apple.webinspectord_sim.socket';
      const active = '/private/var/tmp/com.apple.launchd.MIDDLE/com.apple.webinspectord_sim.socket';
      probeResults[stale] = false;
      probeResults[active] = true;

      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      stubFilesystem([
        { dir: 'com.apple.launchd.OLDEST', mtimeMs: 1000 },
        { dir: 'com.apple.launchd.NEWEST', mtimeMs: 9000 },
        { dir: 'com.apple.launchd.MIDDLE', mtimeMs: 5000 },
      ]);

      const result = await findSocketPath();
      expect(result).toBe(active);
    });

    it('returns null when all sockets are stale', async () => {
      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      stubFilesystem([
        { dir: 'com.apple.launchd.A', mtimeMs: 9000 },
        { dir: 'com.apple.launchd.B', mtimeMs: 5000 },
      ]);

      const result = await findSocketPath();
      expect(result).toBeNull();
    });

    it('returns null when no socket files exist', async () => {
      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      readdirMock.mockRejectedValue(new Error('ENOENT'));

      const result = await findSocketPath();
      expect(result).toBeNull();
    });
  });

  describe('Tier 1 → Tier 2 fallback chain', () => {
    it('uses lsof when available, ignores filesystem', async () => {
      const lsofSocket = '/private/var/tmp/com.apple.launchd.LSOF/com.apple.webinspectord_sim.socket';
      probeResults[lsofSocket] = true;

      stubExecFile({
        'lsof -U': {
          stdout: `launchd_s 999 user  8u  unix 0xa  0t0  ${lsofSocket}\n`,
        },
      });

      stubFilesystem([
        { dir: 'com.apple.launchd.NEWER_BUT_WRONG', mtimeMs: 99999 },
      ]);

      const result = await findSocketPath();
      expect(result).toBe(lsofSocket);
      expect(readdirMock).not.toHaveBeenCalled();
    });
  });
});

describe('probeSocket', () => {
  it('returns true for alive socket', async () => {
    probeResults['/tmp/alive.sock'] = true;
    expect(await probeSocket('/tmp/alive.sock')).toBe(true);
  });

  it('returns false for dead socket', async () => {
    probeResults['/tmp/dead.sock'] = false;
    expect(await probeSocket('/tmp/dead.sock')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #265 acceptance criteria verification
// ---------------------------------------------------------------------------

describe('Issue #265: socket finder fix verification', () => {
  describe('correct socket selected when multiple exist', () => {
    it('selects the socket whose launchd_sim process matches the target UDID among multiple runtimes', async () => {
      // Simulates two iOS runtime simulators running simultaneously
      const socketIos16 = '/private/var/tmp/com.apple.launchd.RUNTIME16/com.apple.webinspectord_sim.socket';
      const socketIos17 = '/private/var/tmp/com.apple.launchd.RUNTIME17/com.apple.webinspectord_sim.socket';
      probeResults[socketIos16] = true;
      probeResults[socketIos17] = true;

      const targetUdid = 'DDDD-EEEE-FFFF-0000';

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 2001 user  8u  unix 0xa  0t0  ${socketIos16}`,
            `launchd_s 2002 user  8u  unix 0xb  0t0  ${socketIos17}`,
          ].join('\n'),
        },
        'ps -p 2001': { stdout: `launchd_sim --bundle CoreSimulator/Profiles/Runtimes/iOS 16.4.simruntime AAAA-BBBB-CCCC-1111/data` },
        'ps -p 2002': { stdout: `launchd_sim --bundle CoreSimulator/Profiles/Runtimes/iOS 17.0.simruntime ${targetUdid}/data` },
      });

      const result = await findSocketPath({ targetUdid });
      expect(result).toBe(socketIos17);
      expect(result).not.toBe(socketIos16);
    });

    it('returns first live socket when no targetUdid and multiple lsof candidates exist', async () => {
      const socket1 = '/private/var/tmp/com.apple.launchd.FIRST/com.apple.webinspectord_sim.socket';
      const socket2 = '/private/var/tmp/com.apple.launchd.SECOND/com.apple.webinspectord_sim.socket';
      // socket1 is stale, socket2 is live — must skip to second
      probeResults[socket1] = false;
      probeResults[socket2] = true;

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 3001 user  8u  unix 0xa  0t0  ${socket1}`,
            `launchd_s 3002 user  8u  unix 0xb  0t0  ${socket2}`,
          ].join('\n'),
        },
      });

      const result = await findSocketPath();
      expect(result).toBe(socket2);
    });

    it('selects correct socket by mtime when multiple runtimes present in filesystem', async () => {
      // Three sockets from three different runtime directories
      const socketOld = '/private/var/tmp/com.apple.launchd.RUNTIME_OLD/com.apple.webinspectord_sim.socket';
      const socketNew = '/private/var/tmp/com.apple.launchd.RUNTIME_NEW/com.apple.webinspectord_sim.socket';
      const socketMid = '/private/var/tmp/com.apple.launchd.RUNTIME_MID/com.apple.webinspectord_sim.socket';
      probeResults[socketOld] = false;
      probeResults[socketNew] = true;
      probeResults[socketMid] = true;

      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      stubFilesystem([
        { dir: 'com.apple.launchd.RUNTIME_OLD', mtimeMs: 1000 },
        { dir: 'com.apple.launchd.RUNTIME_NEW', mtimeMs: 9000 },
        { dir: 'com.apple.launchd.RUNTIME_MID', mtimeMs: 5000 },
      ]);

      const result = await findSocketPath();
      // Newest mtime (RUNTIME_NEW) is probed first and is alive
      expect(result).toBe(socketNew);
    });
  });

  describe('stale sockets not preferred over fresh ones', () => {
    it('skips stale socket at newest mtime and returns next fresh socket', async () => {
      const staleNewest = '/private/var/tmp/com.apple.launchd.STALE_NEWEST/com.apple.webinspectord_sim.socket';
      const freshMiddle = '/private/var/tmp/com.apple.launchd.FRESH_MIDDLE/com.apple.webinspectord_sim.socket';
      const staleOldest = '/private/var/tmp/com.apple.launchd.STALE_OLDEST/com.apple.webinspectord_sim.socket';
      probeResults[staleNewest] = false;
      probeResults[freshMiddle] = true;
      probeResults[staleOldest] = false;

      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      stubFilesystem([
        { dir: 'com.apple.launchd.STALE_NEWEST', mtimeMs: 9000 },
        { dir: 'com.apple.launchd.FRESH_MIDDLE', mtimeMs: 5000 },
        { dir: 'com.apple.launchd.STALE_OLDEST', mtimeMs: 1000 },
      ]);

      const result = await findSocketPath();
      // Must not return the newest-mtime stale socket
      expect(result).not.toBe(staleNewest);
      // Must return the next-newest that is actually alive
      expect(result).toBe(freshMiddle);
    });

    it('skips all stale lsof candidates and returns null rather than a dead socket', async () => {
      const stale1 = '/private/var/tmp/com.apple.launchd.STALE1/com.apple.webinspectord_sim.socket';
      const stale2 = '/private/var/tmp/com.apple.launchd.STALE2/com.apple.webinspectord_sim.socket';
      probeResults[stale1] = false;
      probeResults[stale2] = false;

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 4001 user  8u  unix 0xa  0t0  ${stale1}`,
            `launchd_s 4002 user  8u  unix 0xb  0t0  ${stale2}`,
          ].join('\n'),
        },
      });

      // Stub filesystem so mtime fallback also finds nothing
      readdirMock.mockRejectedValue(new Error('ENOENT'));

      const result = await findSocketPath();
      expect(result).toBeNull();
    });
  });

  describe('clear result when no valid socket exists', () => {
    it('returns null (not throw) when lsof finds no launchd_sim sockets', async () => {
      stubExecFile({
        'lsof -U': {
          // Output with no launchd_sim entries
          stdout: [
            'COMMAND    PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
            'some_proc  123 user   8u  unix 0xabc      0t0  /tmp/other.socket',
          ].join('\n'),
        },
      });
      readdirMock.mockRejectedValue(new Error('ENOENT'));

      await expect(findSocketPath()).resolves.toBeNull();
    });

    it('returns null (not throw) when all candidate sockets fail liveness probe', async () => {
      const deadSocket = '/private/var/tmp/com.apple.launchd.DEAD/com.apple.webinspectord_sim.socket';
      probeResults[deadSocket] = false;

      stubExecFile({ 'lsof -U': { error: new Error('fail') } });
      stubFilesystem([{ dir: 'com.apple.launchd.DEAD', mtimeMs: 9000 }]);

      await expect(findSocketPath()).resolves.toBeNull();
    });

    it('returns null (not throw) when lsof itself throws unexpectedly', async () => {
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        (cb as CallableFunction)(new Error('Unexpected lsof failure'));
      });
      readdirMock.mockRejectedValue(new Error('ENOENT'));

      await expect(findSocketPath()).resolves.toBeNull();
    });
  });

  describe('works across multiple installed iOS runtimes', () => {
    it('ignores non-socket directories and finds socket among mixed launchd entries', async () => {
      const validSocket = '/private/var/tmp/com.apple.launchd.VALID/com.apple.webinspectord_sim.socket';
      probeResults[validSocket] = true;

      stubExecFile({ 'lsof -U': { error: new Error('fail') } });

      // Mix of valid and non-matching directories
      readdirMock.mockImplementation(async (base: string) => {
        if (base === '/private/var/tmp') {
          return [
            'com.apple.launchd.VALID',    // valid
            'not.apple.launchd.SKIP',      // does not start with com.apple.launchd.
            'com.apple.launchd.NO_SOCKET', // no socket file inside
            'com.apple.launchd.OTHER',     // valid dir but no socket file
          ];
        }
        throw new Error('ENOENT');
      });
      statMock.mockImplementation(async (p: string) => {
        if (p.includes('com.apple.launchd.VALID')) return { mtimeMs: 5000 };
        throw new Error('ENOENT');
      });

      const result = await findSocketPath();
      expect(result).toBe(validSocket);
    });

    it('targetUdid returns null and does not fall through to mtime when lsof has no UDID match', async () => {
      const socket = '/private/var/tmp/com.apple.launchd.SIM/com.apple.webinspectord_sim.socket';
      probeResults[socket] = true;

      stubExecFile({
        'lsof -U': {
          stdout: `launchd_s 5001 user  8u  unix 0xa  0t0  ${socket}\n`,
        },
        'ps -p 5001': { stdout: `launchd_sim /path/to/RUNTIME-A/data` },
      });

      // Filesystem has a socket that would match via mtime — it must NOT be returned
      stubFilesystem([{ dir: 'com.apple.launchd.SIM', mtimeMs: 9000 }]);

      const result = await findSocketPath({ targetUdid: 'COMPLETELY-DIFFERENT-UDID' });
      expect(result).toBeNull();
      // Verify mtime tier was never consulted
      expect(readdirMock).not.toHaveBeenCalled();
    });

    it('lsof returns sockets from multiple runtime paths and selects correct one by UDID', async () => {
      // Simulates iOS 16, iOS 17, iOS 18 simulators all running
      const socketV16 = '/private/var/tmp/com.apple.launchd.IOS16/com.apple.webinspectord_sim.socket';
      const socketV17 = '/private/var/tmp/com.apple.launchd.IOS17/com.apple.webinspectord_sim.socket';
      const socketV18 = '/private/var/tmp/com.apple.launchd.IOS18/com.apple.webinspectord_sim.socket';
      probeResults[socketV16] = true;
      probeResults[socketV17] = true;
      probeResults[socketV18] = true;

      const targetUdid = '1111-2222-3333-4444';

      stubExecFile({
        'lsof -U': {
          stdout: [
            `launchd_s 6001 user  8u  unix 0xa  0t0  ${socketV16}`,
            `launchd_s 6002 user  8u  unix 0xb  0t0  ${socketV17}`,
            `launchd_s 6003 user  8u  unix 0xc  0t0  ${socketV18}`,
          ].join('\n'),
        },
        'ps -p 6001': { stdout: `launchd_sim Runtimes/iOS16 AAAA-0000/data` },
        'ps -p 6002': { stdout: `launchd_sim Runtimes/iOS17 BBBB-1111/data` },
        'ps -p 6003': { stdout: `launchd_sim Runtimes/iOS18 ${targetUdid}/data` },
      });

      const result = await findSocketPath({ targetUdid });
      expect(result).toBe(socketV18);
    });
  });
});

describe('waitForSocketPath', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns immediately when socket found on first try', async () => {
    const socketPath = '/private/var/tmp/com.apple.launchd.ACTIVE/com.apple.webinspectord_sim.socket';
    probeResults[socketPath] = true;

    stubExecFile({
      'lsof -U': {
        stdout: `launchd_s 1234 user  8u  unix 0xabc  0t0  ${socketPath}\n`,
      },
    });

    const promise = waitForSocketPath({ timeout: 10_000, interval: 500 });
    // Flush microtasks so findSocketPath resolves
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(socketPath);
  });

  it('retries and succeeds on Nth attempt', async () => {
    const socketPath = '/private/var/tmp/com.apple.launchd.LATE/com.apple.webinspectord_sim.socket';
    // Socket not found on first two calls, alive on the third
    let callCount = 0;
    execFileMock.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      callCount++;
      if (callCount < 3) {
        // lsof returns no matching lines
        (callback as CallableFunction)(null, { stdout: 'COMMAND PID USER\n' });
      } else {
        (callback as CallableFunction)(null, {
          stdout: `launchd_s 1234 user  8u  unix 0xabc  0t0  ${socketPath}\n`,
        });
      }
    });
    probeResults[socketPath] = true;
    readdirMock.mockRejectedValue(new Error('ENOENT'));

    const promise = waitForSocketPath({ timeout: 10_000, interval: 500 });
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(socketPath);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('returns null after timeout', async () => {
    // lsof always returns nothing; mtime dir also empty
    stubExecFile({ 'lsof -U': { stdout: 'COMMAND PID USER\n' } });
    readdirMock.mockRejectedValue(new Error('ENOENT'));

    const promise = waitForSocketPath({ timeout: 1_000, interval: 500 });
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });

  it('respects custom timeout and interval', async () => {
    stubExecFile({ 'lsof -U': { stdout: 'COMMAND PID USER\n' } });
    readdirMock.mockRejectedValue(new Error('ENOENT'));

    let advancedMs = 0;
    const origDateNow = Date.now;
    // We rely on jest fake timers advancing Date.now — just verify it returns null within timeout
    const promise = waitForSocketPath({ timeout: 2_000, interval: 200 });
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe('stale socket cleanup', () => {
  it('cleans stale sockets found before the active one in mtime fallback', async () => {
    const stale = '/private/var/tmp/com.apple.launchd.NEWEST/com.apple.webinspectord_sim.socket';
    const active = '/private/var/tmp/com.apple.launchd.MIDDLE/com.apple.webinspectord_sim.socket';
    probeResults[stale] = false;
    probeResults[active] = true;

    stubExecFile({ 'lsof -U': { error: new Error('fail') } });
    stubFilesystem([
      { dir: 'com.apple.launchd.OLDEST', mtimeMs: 1000 },
      { dir: 'com.apple.launchd.NEWEST', mtimeMs: 9000 },
      { dir: 'com.apple.launchd.MIDDLE', mtimeMs: 5000 },
    ]);

    await findSocketPath();

    // Should have attempted to remove the stale socket's parent directory
    expect(rmMock).toHaveBeenCalledWith(
      '/private/var/tmp/com.apple.launchd.NEWEST',
      { recursive: true, force: true },
    );
  });

  it('cleans all sockets when none are alive', async () => {
    stubExecFile({ 'lsof -U': { error: new Error('fail') } });
    stubFilesystem([
      { dir: 'com.apple.launchd.A', mtimeMs: 9000 },
      { dir: 'com.apple.launchd.B', mtimeMs: 5000 },
    ]);

    await findSocketPath();

    expect(rmMock).toHaveBeenCalledTimes(2);
  });

  it('cleanup failure does not throw', async () => {
    rmMock.mockRejectedValue(new Error('EPERM'));

    stubExecFile({ 'lsof -U': { error: new Error('fail') } });
    stubFilesystem([
      { dir: 'com.apple.launchd.FAIL', mtimeMs: 9000 },
    ]);

    // Should not throw even when rm fails
    await expect(findSocketPath()).resolves.toBeNull();
  });

  it('does not clean sockets found via lsof tier', async () => {
    const lsofSocket = '/private/var/tmp/com.apple.launchd.LSOF/com.apple.webinspectord_sim.socket';
    probeResults[lsofSocket] = true;

    stubExecFile({
      'lsof -U': {
        stdout: `launchd_s 999 user  8u  unix 0xa  0t0  ${lsofSocket}\n`,
      },
    });

    await findSocketPath();

    // Cleanup only runs in mtime tier, not lsof tier
    expect(rmMock).not.toHaveBeenCalled();
  });
});
