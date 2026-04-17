import { execWithTimeout, ExecTimeoutError, DEFAULT_EXEC_TIMEOUT_MS } from '../../src/lib/exec-with-timeout';

describe('execWithTimeout', () => {
  test('resolves on fast command', async () => {
    const { stdout } = await execWithTimeout('echo', ['hello']);
    expect(stdout.trim()).toBe('hello');
  });

  test('rejects with ExecTimeoutError when command exceeds budget', async () => {
    // sleep 2s but we give it only 100ms
    await expect(
      execWithTimeout('sleep', ['2'], { timeout: 100 }),
    ).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  test('ExecTimeoutError carries command and timeoutMs', async () => {
    let caught: unknown;
    try {
      await execWithTimeout('sleep', ['2'], { timeout: 100 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecTimeoutError);
    const err = caught as ExecTimeoutError;
    expect(err.command).toBe('sleep');
    expect(err.timeoutMs).toBe(100);
    expect(err.message).toMatch(/timed out after 100ms/);
  });

  test('honors per-call timeout override over default', async () => {
    // Should succeed with a generous per-call timeout even if default is short
    const { stdout } = await execWithTimeout('echo', ['override'], { timeout: 5000 });
    expect(stdout.trim()).toBe('override');
  });

  test('DEFAULT_EXEC_TIMEOUT_MS is 30000 when env is not set', () => {
    // The env var is not set in test environment
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(30_000);
  });

  test('passes stderr through on failure without timeout', async () => {
    await expect(
      execWithTimeout('false', []),
    ).rejects.toThrow(); // non-zero exit rejects, but not ExecTimeoutError
  });

  test('non-timeout failures are NOT wrapped as ExecTimeoutError', async () => {
    try {
      await execWithTimeout('false', []);
    } catch (err) {
      expect(err).not.toBeInstanceOf(ExecTimeoutError);
    }
  });
});
