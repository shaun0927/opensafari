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

/** Default timeout in milliseconds — 30 s, overridable via env. */
export const DEFAULT_EXEC_TIMEOUT_MS: number =
  parseInt(process.env.OPENSAFARI_EXEC_TIMEOUT_MS ?? '', 10) || 30_000;

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
