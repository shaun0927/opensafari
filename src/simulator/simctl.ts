import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class SimctlExecutor {
  async exec(args: string[], options?: { timeout?: number }): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
        timeout: options?.timeout ?? 30000,
      });
      return stdout;
    } catch (err: unknown) {
      const error = err as Error & { stderr?: string; code?: number };
      throw new SimctlError(
        `simctl ${args.join(' ')} failed: ${error.stderr || error.message}`,
        args,
        error.code,
      );
    }
  }

  async execJson<T>(args: string[]): Promise<T> {
    const output = await this.exec([...args, '-j']);
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new SimctlError(`Failed to parse JSON from simctl ${args.join(' ')}`, args);
    }
  }
}

export class SimctlError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'SimctlError';
  }
}
