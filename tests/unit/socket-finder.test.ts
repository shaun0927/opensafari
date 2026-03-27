import * as childProcess from 'child_process';
import * as fsPromises from 'fs/promises';
import { EventEmitter } from 'events';
import { findSocketPath, probeSocket } from '../../src/simulator/socket-finder';

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
