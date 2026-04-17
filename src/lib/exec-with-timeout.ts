/**
 * execFileAsync with an enforced default timeout.
 *
 * Drop-in replacement for `promisify(execFile)` that sets a default timeout
 * of 30 s (overridable via the OPENSAFARI_EXEC_TIMEOUT_MS env var, or per
 * call via the `timeout` option). When the process exceeds the budget the
 * child is killed and an ExecTimeoutError is thrown.
 *
 * Usage:
 *   import { execWithTimeout } from '../lib/exec-with-timeout';
 *   const { stdout } = await execWithTimeout('xcrun', ['simctl', 'list']);
 */

import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FALLBACK_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647; // INT32_MAX — Node's execFile upper bound

/**
 * Parse `OPENSAFARI_EXEC_TIMEOUT_MS` (or any caller-supplied env value) into
 * a safe execFile timeout. Rejects negative, zero, NaN, decimal, and
 * out-of-range values — Node's execFile throws `ERR_OUT_OF_RANGE` when
 * `timeout` is negative or above INT32_MAX, which would make every migrated
 * call fail immediately instead of falling back to the safe default.
 *
 * Exported for test coverage; consumers should use `DEFAULT_EXEC_TIMEOUT_MS`.
 */
export function parseEnvTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return FALLBACK_TIMEOUT_MS;
  // Use Number() (not parseInt) so decimal strings like "1.5" are rejected
  // by the integer check rather than being silently truncated to 1.
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS) return n;
  process.stderr.write(
    `[exec] invalid OPENSAFARI_EXEC_TIMEOUT_MS=${raw}, falling back to ${FALLBACK_TIMEOUT_MS}ms\n`,
  );
  return FALLBACK_TIMEOUT_MS;
}

/** Default timeout in milliseconds — 30 s, overridable via env. */
export const DEFAULT_EXEC_TIMEOUT_MS: number = parseEnvTimeout(
  process.env.OPENSAFARI_EXEC_TIMEOUT_MS,
);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Typed error emitted when execWithTimeout exceeds the timeout budget.
 * Extends Error so existing `catch` blocks that inspect `err.message` keep
 * working; callers that need to distinguish timeouts can check `instanceof`.
 */
export class ExecTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ExecTimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Execute a file with an enforced timeout.
 *
 * If `options.timeout` is omitted, DEFAULT_EXEC_TIMEOUT_MS is used.
 * The child process is killed (SIGTERM) when the timeout fires, and
 * an ExecTimeoutError is thrown in place of the underlying error.
 */
export async function execWithTimeout(
  file: string,
  args: string[],
  options?: ExecFileOptions & { timeout?: number },
): Promise<ExecResult> {
  const timeout = options?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS;
  const opts: ExecFileOptions = { ...options, timeout };

  try {
    const { stdout, stderr } = await execFileAsync(file, args, opts);
    return {
      stdout: stdout as string,
      stderr: stderr as string,
    };
  } catch (err: unknown) {
    // Node.js sets err.killed = true when the timeout fires and kills the child.
    // The signal is 'SIGTERM' and the code is null. Check for the kill flag.
    const killed = (err as Record<string, unknown>)['killed'];
    if (killed === true) {
      throw new ExecTimeoutError(file, timeout);
    }
    throw err;
  }
}
