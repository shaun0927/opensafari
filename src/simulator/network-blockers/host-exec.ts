/**
 * Production HostExec backed by child_process.execFile.
 *
 * Kept isolated from the blocker modules so unit tests can import the
 * blockers without pulling in any Node child-process code and so tests
 * can mock the interface with an ordinary object literal.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { HostExec, HostExecOptions } from './types';

const execFileAsync = promisify(execFile);

export class RealHostExec implements HostExec {
  async run(cmd: string, args: string[], options: HostExecOptions = {}): Promise<string> {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: options.timeoutMs ?? 10_000,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        encoding: 'utf8',
      });
      return stdout;
    } catch (err) {
      if (options.allowNonZero) {
        const e = err as Error & { stdout?: string; stderr?: string };
        return e.stdout ?? '';
      }
      throw err;
    }
  }
}
