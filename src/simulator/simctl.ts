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

// ── bootstatus capability probe ───────────────────────────────────────────────

/**
 * Cached result of the bootstatus capability check. Undefined means not yet
 * probed; the probe runs once per process lifetime (the installed Xcode does
 * not change while the process runs).
 */
let bootstatusCapable: boolean | undefined;

/**
 * In-flight probe Promise — memoised so that concurrent callers at startup
 * all await the same single probe instead of firing N redundant exec calls.
 */
let bootstatusProbePromise: Promise<boolean> | undefined;

/**
 * Return true when `xcrun simctl bootstatus <udid> -b` is available on this
 * host's Xcode/simctl version. The result is memoised for the process lifetime.
 *
 * `bootstatus` was introduced in Xcode 13 / simctl 830.1; older versions exit
 * with a non-zero code and print "Unknown command: bootstatus" to stderr.
 *
 * Concurrent callers that arrive before the first probe completes all share
 * the same in-flight Promise, preventing redundant probes.
 */
export function hasBootstatus(simctl: SimctlExecutor): Promise<boolean> {
  if (bootstatusCapable !== undefined) return Promise.resolve(bootstatusCapable);
  if (bootstatusProbePromise) return bootstatusProbePromise;

  bootstatusProbePromise = (async () => {
    try {
      // Probe with a clearly invalid UDID so we don't accidentally wait on a
      // real device. simctl will reject the UDID with a device-not-found error
      // (exit 1), but it will NOT print "Unknown command" — that distinguishes
      // "command exists but UDID bad" from "command does not exist".
      await simctl.exec(['bootstatus', '00000000-0000-0000-0000-000000000000', '-b'], { timeout: 5000 });
      bootstatusCapable = true;
    } catch (err) {
      const msg = err instanceof SimctlError ? err.message : String(err);
      // "Unknown command" means the subcommand does not exist on this simctl build.
      bootstatusCapable = !msg.includes('Unknown command') && !msg.includes('unknown command');
    }

    if (process.env.DEBUG) {
      console.error(`[simctl] bootstatus capability: ${bootstatusCapable ? 'available' : 'unavailable (fallback to list)'}`);
    }

    return bootstatusCapable as boolean;
  })();

  return bootstatusProbePromise;
}

/** Reset the capability cache — for unit tests only. */
export function resetBootstatusCapabilityForTests(): void {
  bootstatusCapable = undefined;
  bootstatusProbePromise = undefined;
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
