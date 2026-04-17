import {
  execWithTimeout,
  ExecTimeoutError,
  DEFAULT_EXEC_TIMEOUT_MS,
  parseEnvTimeout,
} from '../../src/lib/exec-with-timeout';

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

describe('parseEnvTimeout', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('returns default when env is undefined (silent)', () => {
    expect(parseEnvTimeout(undefined)).toBe(30_000);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('returns default when env is empty string (silent)', () => {
    expect(parseEnvTimeout('')).toBe(30_000);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('accepts a valid positive integer', () => {
    expect(parseEnvTimeout('5000')).toBe(5000);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('accepts INT32_MAX (2147483647)', () => {
    expect(parseEnvTimeout('2147483647')).toBe(2_147_483_647);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('rejects negative value, warns, falls back to default', () => {
    expect(parseEnvTimeout('-1')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toMatch(/invalid OPENSAFARI_EXEC_TIMEOUT_MS=-1/);
  });

  test('rejects zero, warns, falls back to default', () => {
    expect(parseEnvTimeout('0')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('rejects NaN string, warns, falls back to default', () => {
    expect(parseEnvTimeout('not-a-number')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toMatch(/invalid OPENSAFARI_EXEC_TIMEOUT_MS=not-a-number/);
  });

  test('rejects decimal value (1.5), warns, falls back to default', () => {
    expect(parseEnvTimeout('1.5')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('rejects value above INT32_MAX, warns, falls back to default', () => {
    expect(parseEnvTimeout('9999999999')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('rejects negative integer well below zero', () => {
    expect(parseEnvTimeout('-1000000')).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
