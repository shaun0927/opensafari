import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class SimctlExecutor {
  async exec(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<string> {
    try {
      const execOptions: { timeout: number; env?: NodeJS.ProcessEnv } = {
        timeout: options?.timeout ?? 30000,
      };
      if (options?.env && Object.keys(options.env).length > 0) {
        execOptions.env = { ...process.env, ...options.env };
      }
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], execOptions);
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

// ── resetBootstatusCapabilityForTests ────────────────────────────────────────

/**
 * No-op kept for test-file backward-compatibility.
 * The bootstatus fast-path was removed in favour of the per-UDID
 * `simctl list devices <udid> -j` read, which has no side-effects and
 * requires no capability detection.
 *
 * @deprecated Remove callers when all test files are updated.
 */
export function resetBootstatusCapabilityForTests(): void {
  // intentionally empty — no state to reset
}

// ── SimulatorStateCache ───────────────────────────────────────────────────────

export interface CachedDeviceState {
  udid: string;
  state: 'Booted' | 'Shutdown' | 'Creating' | 'ShuttingDown';
  cachedAt: number;
}

/**
 * Short-lived per-device state cache for simulator polling loops.
 *
 * TTL is intentionally matched to a single polling interval so that multiple
 * callers within the *same tick* share one `simctl list devices` parse, while
 * the next tick always fetches fresh data. This is NOT a long-term inventory
 * cache — it only exists to deduplicate redundant reads within a tight loop.
 *
 * Cache is invalidated immediately on any lifecycle mutation (boot / shutdown /
 * delete) so that callers never observe stale state after an action.
 */
export class SimulatorStateCache {
  private readonly entries = new Map<string, CachedDeviceState>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(udid: string): CachedDeviceState | undefined {
    const entry = this.entries.get(udid);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.entries.delete(udid);
      return undefined;
    }
    return entry;
  }

  set(udid: string, state: CachedDeviceState['state']): void {
    this.entries.set(udid, { udid, state, cachedAt: Date.now() });
  }

  /** Invalidate a specific device entry (call after any lifecycle mutation). */
  invalidate(udid: string): void {
    this.entries.delete(udid);
  }

  /** Invalidate all entries (call after bulk operations). */
  invalidateAll(): void {
    this.entries.clear();
  }
}
