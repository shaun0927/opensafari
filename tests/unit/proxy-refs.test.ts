import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { WebInspectorProxy } from '../../src/simulator/proxy';

// Access private methods via type cast for white-box testing
type ProxyPrivate = {
  getRefFilePath(): string;
  registerRefSync(): void;
  unregisterRefSync(): number;
};

function privateProxy(proxy: WebInspectorProxy): ProxyPrivate {
  return proxy as unknown as ProxyPrivate;
}

describe('WebInspectorProxy ref tracking', () => {
  let proxy: WebInspectorProxy;
  let refFile: string;

  beforeEach(() => {
    // Use a unique deviceListPort per test to avoid cross-test collisions
    proxy = new WebInspectorProxy({ deviceListPort: 19321 });
    refFile = privateProxy(proxy).getRefFilePath();
    // Clean up any leftover ref file before each test
    try { unlinkSync(refFile); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { unlinkSync(refFile); } catch { /* ignore */ }
  });

  it('registerRefSync creates ref file with current PID', () => {
    privateProxy(proxy).registerRefSync();
    expect(existsSync(refFile)).toBe(true);
    const content = readFileSync(refFile, 'utf-8');
    const pids = content.trim().split('\n').map(Number).filter(Boolean);
    expect(pids).toContain(process.pid);
  });

  it('registerRefSync does not duplicate current PID on repeated calls', () => {
    privateProxy(proxy).registerRefSync();
    privateProxy(proxy).registerRefSync();
    const content = readFileSync(refFile, 'utf-8');
    const pids = content.trim().split('\n').map(Number).filter(Boolean);
    const occurrences = pids.filter(p => p === process.pid).length;
    expect(occurrences).toBe(1);
  });

  it('unregisterRefSync removes current PID and returns remaining count', () => {
    // Write a ref file with a fake live PID (current process) plus self
    writeFileSync(refFile, `${process.pid}\n`);
    const remaining = privateProxy(proxy).unregisterRefSync();
    expect(remaining).toBe(0);
    expect(existsSync(refFile)).toBe(false);
  });

  it('unregisterRefSync cleans stale PIDs from ref file', () => {
    // PID 2147483647 is virtually guaranteed not to exist
    const stalePid = 2147483647;
    writeFileSync(refFile, `${stalePid}\n${process.pid}\n`);
    const remaining = privateProxy(proxy).unregisterRefSync();
    // stalePid is stale and process.pid is removed — nothing left
    expect(remaining).toBe(0);
    expect(existsSync(refFile)).toBe(false);
  });

  it('unregisterRefSync deletes ref file when count reaches 0', () => {
    writeFileSync(refFile, `${process.pid}\n`);
    privateProxy(proxy).unregisterRefSync();
    expect(existsSync(refFile)).toBe(false);
  });

  it('unregisterRefSync returns 0 when ref file does not exist', () => {
    // No file written — should not throw
    const remaining = privateProxy(proxy).unregisterRefSync();
    expect(remaining).toBe(0);
  });

  it('stop() with remaining refs detaches without killing: unregisterRefSync returns remaining count', async () => {
    // Simulate two processes registered: this process (us) plus a second live process
    // standing in for another session. We use async spawn so the child stays alive while
    // we run the assertion — spawnSync would wait for exit, leaving a dead PID.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const otherPid: number = child.pid;

    // Give the child a moment to register in the OS process table
    await new Promise(r => setTimeout(r, 100));

    try {
      // Verify otherPid is actually live before proceeding
      process.kill(otherPid, 0);

      // Write ref file: other session PID + our own PID (two active refs)
      writeFileSync(refFile, `${otherPid}\n${process.pid}\n`);

      // unregisterRefSync should remove our PID, keep otherPid, and return 1
      const remaining = privateProxy(proxy).unregisterRefSync();

      expect(remaining).toBe(1);
      // Ref file must still exist because otherPid is still live
      expect(existsSync(refFile)).toBe(true);
      const survivors = readFileSync(refFile, 'utf-8')
        .trim().split('\n').map(Number).filter(Boolean);
      expect(survivors).toContain(otherPid);
      expect(survivors).not.toContain(process.pid);
    } finally {
      // Clean up the child process
      try { process.kill(otherPid, 'SIGKILL'); } catch { /* already gone */ }
      child.unref();
    }
  });
});
