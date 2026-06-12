/**
 * WebInspectorProxy supervised auto-restart.
 *
 * An unexpected ios_webkit_debug_proxy exit previously left the proxy down
 * permanently (every WebKit reconnect failed until the MCP server was
 * restarted). The supervisor restarts the proxy with exponential backoff,
 * but must never fight an intentional stop()/detach, and must give up after
 * a capped number of attempts so a broken environment cannot spawn-loop.
 */
const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
const mockSpawn = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: mockSpawn,
    execFile: Object.assign(
      jest.fn((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args)),
      { [Symbol.for('nodejs.util.promisify.custom')]: mockExecFileAsync },
    ),
  };
});

import { EventEmitter } from 'events';
import { WebInspectorProxy } from '../../src/simulator/proxy';
import * as socketFinder from '../../src/simulator/socket-finder';

interface FakeProc extends EventEmitter {
  pid: number;
  stderr: { on: jest.Mock };
  kill: jest.Mock;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = 4242;
  proc.stderr = { on: jest.fn() };
  // SIGTERM from teardown kills the fake process immediately.
  proc.kill = jest.fn(() => {
    proc.emit('exit', 0);
    return true;
  });
  return proc;
}

describe('WebInspectorProxy supervised restart', () => {
  let proxy: WebInspectorProxy;
  let consoleErrorSpy: jest.SpyInstance;
  let socketSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockReset();
    mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '/usr/local/bin/ios_webkit_debug_proxy\n', stderr: '' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    proxy = new WebInspectorProxy({ port: 9622, deviceListPort: 9621 });
    jest
      .spyOn(proxy as unknown as { isPortInUse(port: number): Promise<boolean> }, 'isPortInUse')
      .mockResolvedValue(false);
    jest
      .spyOn(proxy as unknown as { httpGet(url: string): Promise<string> }, 'httpGet')
      .mockResolvedValue('[]'); // process-ready signal
    jest
      .spyOn(proxy as unknown as { registerRefSync(): void }, 'registerRefSync')
      .mockImplementation(() => {});
    jest
      .spyOn(proxy as unknown as { unregisterRefSync(): number }, 'unregisterRefSync')
      .mockReturnValue(0);
    socketSpy = jest
      .spyOn(socketFinder, 'waitForSocketPath')
      .mockResolvedValue('/tmp/fake-inspector.sock');
  });

  afterEach(async () => {
    await proxy.stop().catch(() => {});
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function restartLogCount(pattern: string): number {
    return consoleErrorSpy.mock.calls.filter((c) => String(c[0]).includes(pattern)).length;
  }

  test('unexpected exit schedules a restart and respawns the proxy', async () => {
    const proc1 = makeFakeProc();
    const proc2 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    await proxy.start();
    expect(proxy.running).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    proc1.emit('exit', 1); // crash
    expect(proxy.running).toBe(false);

    await jest.advanceTimersByTimeAsync(1_500); // past the 1s base backoff
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(proxy.running).toBe(true);
  });

  test('caller stop() never triggers a restart', async () => {
    const proc1 = makeFakeProc();
    mockSpawn.mockReturnValue(proc1);

    await proxy.start();
    await proxy.stop(); // kill -> exit fires with stopRequested set

    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('detach path (other sessions still using the proxy) never restarts', async () => {
    const proc1 = makeFakeProc();
    mockSpawn.mockReturnValue(proc1);
    (proxy as unknown as { unregisterRefSync(): number }).unregisterRefSync = jest
      .fn()
      .mockReturnValue(2); // other sessions remain

    await proxy.start();
    await proxy.stop(); // detaches without killing
    expect(proc1.kill).not.toHaveBeenCalled();

    proc1.emit('exit', 0); // the shared process dies later
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('internal cleanup of a failed start does not suppress future supervision', async () => {
    const proc1 = makeFakeProc();
    const proc2 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    await proxy.start();
    proc1.emit('exit', 1); // crash -> supervisor kicks in
    await jest.advanceTimersByTimeAsync(1_500);
    expect(proxy.running).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('gives up after the attempt cap when restarts keep failing', async () => {
    const proc1 = makeFakeProc();
    mockSpawn.mockReturnValue(proc1);

    await proxy.start();

    // Every restart attempt now fails before spawning (no inspector socket).
    socketSpy.mockResolvedValue(null);
    proc1.emit('exit', 1);

    // Backoff schedule: 1s, 2s, 4s, 8s, 16s -> all within 60s
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockSpawn).toHaveBeenCalledTimes(1); // never got past the socket check
    expect(restartLogCount('giving up after 5 restart attempts')).toBe(1);

    // And stays down: no further timers pending
    await jest.advanceTimersByTimeAsync(120_000);
    expect(restartLogCount('Unexpected exit')).toBe(5);
  });

  test('a stable run resets the attempt counter', async () => {
    const proc1 = makeFakeProc();
    const proc2 = makeFakeProc();
    const proc3 = makeFakeProc();
    mockSpawn
      .mockReturnValueOnce(proc1)
      .mockReturnValueOnce(proc2)
      .mockReturnValueOnce(proc3);

    await proxy.start();
    proc1.emit('exit', 1); // crash #1 -> attempt 1
    await jest.advanceTimersByTimeAsync(1_500);
    expect(proxy.running).toBe(true);

    // proc2 stays up past the stability window, then crashes
    await jest.advanceTimersByTimeAsync(61_000);
    proc2.emit('exit', 1);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(proxy.running).toBe(true);

    // Both crashes were logged as attempt 1/5 (counter reset in between)
    expect(restartLogCount('attempt 1/5')).toBe(2);
  });
});
