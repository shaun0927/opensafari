/**
 * SimPool — Clone-based pool of iOS Simulators for Phase 2B.2 of #408.
 *
 * The default parallel-QA path (Phase 2A / #411) uses a single simulator
 * with multiple Safari tabs, which covers 95% of web QA scenarios with
 * minimal RAM overhead. SimPool handles the remaining 5%: tests that
 * need a different viewport, a native app under test, or fully isolated
 * cookie/session state.
 *
 * Architecture:
 *   1. A **master simulator** is prepared once per device preset. This
 *      can be an existing simulator or a newly created one.
 *   2. `acquire(preset)` calls `simctl clone` on the master, boots the
 *      clone, and returns a `PooledSimulator` with the clone's UDID.
 *      Clone + boot is typically ~2 seconds vs ~20 seconds cold boot.
 *   3. `release(udid)` shuts down the clone and (unless explicitly kept)
 *      deletes it so RAM and disk space are reclaimed immediately.
 *   4. `shutdown()` releases every outstanding clone — called from tests
 *      and process exit.
 *
 * The master simulator is itself found via the normal preset resolution
 * (`SimulatorManager.resolveDevice`), so users don't have to pre-create
 * anything. The first `acquire` for a preset creates the master if the
 * preset has not been booted yet.
 *
 * Concurrency:
 *   - A per-preset **lock** prevents parallel clones from racing on the
 *     same master simulator (simctl clone requires the source to be
 *     Shutdown).
 *   - A configurable `maxClones` cap prevents OOM; the default is read
 *     from `OPENSAFARI_MAX_SIMULATORS` (falls back to DEFAULT_MAX_SIMULATORS).
 */

import { SimulatorManager } from './manager';
import { SimctlExecutor } from './simctl';
import { SimulatorDevice } from './types';
import { DEFAULT_MAX_SIMULATORS } from '../config/defaults';
import { disableBackgroundServices } from './post-boot-optimize';

export interface PooledSimulator {
  /** UDID of the cloned simulator (distinct from the master). */
  udid: string;
  /** The preset key the clone was derived from. */
  preset: string;
  /** Clone's device name (includes a pool tag for easier grep in simctl). */
  name: string;
  /** When the clone was acquired. */
  acquiredAt: number;
  /** If true, release() will NOT delete the clone (for debugging). */
  keepOnRelease?: boolean;
}

export interface SimPoolOptions {
  /** Maximum number of concurrent clones. Defaults to OPENSAFARI_MAX_SIMULATORS. */
  maxClones?: number;
  /** Disable background services on each cloned simulator post-boot. Default: true. */
  disableServices?: boolean;
  /** Custom SimctlExecutor, mainly for tests. */
  simctl?: SimctlExecutor;
  /** Custom SimulatorManager, mainly for tests. */
  manager?: SimulatorManager;
}

/**
 * Per-preset mutex to serialize clone operations on the same master.
 * `simctl clone` refuses to operate on a booted source, so we must
 * ensure only one clone runs at a time for each preset.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    return () => {
      this.locked = false;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export class SimPool {
  private readonly simctl: SimctlExecutor;
  private readonly manager: SimulatorManager;
  private readonly maxClones: number;
  private readonly disableServices: boolean;
  private readonly clones: Map<string, PooledSimulator> = new Map();
  private readonly perPresetLocks: Map<string, AsyncMutex> = new Map();
  /**
   * Per-preset override for the master UDID to clone from. When a preset
   * key is mapped here, `acquire(preset)` will clone that explicit UDID
   * instead of letting `resolveDevice(preset)` pick the first match.
   *
   * Use `setMaster(preset, udid)` to pre-configure a master simulator with
   * cookies, logins, permissions, or installed apps, and every clone
   * derived from it will inherit that state (APFS copy-on-write).
   */
  private readonly masterOverrides: Map<string, string> = new Map();

  constructor(options?: SimPoolOptions) {
    this.simctl = options?.simctl ?? new SimctlExecutor();
    this.manager = options?.manager ?? new SimulatorManager();
    this.disableServices = options?.disableServices ?? true;

    const envMax = parseInt(process.env.OPENSAFARI_MAX_SIMULATORS ?? '', 10);
    this.maxClones =
      options?.maxClones ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_SIMULATORS);
  }

  /** Number of currently outstanding clones. */
  get size(): number {
    return this.clones.size;
  }

  /** List all active clones. */
  list(): PooledSimulator[] {
    return Array.from(this.clones.values());
  }

  /**
   * Register a specific simulator UDID as the master for a preset. Every
   * subsequent `acquire(preset)` will clone from this UDID instead of
   * whichever simulator `resolveDevice(preset)` happens to pick first.
   *
   * Use this when you have a pre-configured simulator with cookies,
   * logins, permissions, or installed apps that every clone should
   * inherit. Each clone gets an APFS copy-on-write snapshot of the
   * master's filesystem, so the inherited state is identical.
   *
   * Passing `null` clears the override and falls back to preset lookup.
   */
  setMaster(preset: string, masterUdid: string | null): void {
    if (masterUdid === null) {
      this.masterOverrides.delete(preset);
    } else {
      this.masterOverrides.set(preset, masterUdid);
    }
  }

  /** Return the registered master UDID for a preset, or null if none. */
  getMaster(preset: string): string | null {
    return this.masterOverrides.get(preset) ?? null;
  }

  /**
   * Acquire a new simulator from the pool by cloning a master of the
   * requested preset. Returns a fully booted `PooledSimulator`. If the
   * maxClones cap would be exceeded, throws a descriptive error.
   *
   * Master selection order:
   *   1. `options.masterUdid` (explicit per-call override)
   *   2. `setMaster(preset, udid)` (pool-level override)
   *   3. `SimulatorManager.resolveDevice(preset)` (default preset lookup)
   */
  async acquire(
    preset: string,
    options?: { keepOnRelease?: boolean; masterUdid?: string },
  ): Promise<PooledSimulator> {
    if (this.clones.size >= this.maxClones) {
      throw new Error(
        `SimPool: max clones reached (${this.clones.size}/${this.maxClones}). ` +
          `Release a clone before acquiring another, or raise OPENSAFARI_MAX_SIMULATORS.`,
      );
    }

    const mutex = this.getLockForPreset(preset);
    const release = await mutex.acquire();

    let cloneUdid: string | null = null;
    try {
      // 1. Resolve the master device for the preset.
      //    Per-call masterUdid beats pool-level setMaster beats preset lookup.
      const explicitMaster = options?.masterUdid ?? this.masterOverrides.get(preset);
      const master = explicitMaster
        ? await this.manager.getDevice(explicitMaster)
        : await this.manager.resolveDevice(preset);
      if (!master) {
        throw new Error(
          `SimPool: master UDID "${explicitMaster}" not found. ` +
            `Use xcrun simctl list devices to verify it exists.`,
        );
      }

      // 2. simctl clone requires the source to be Shutdown.
      if (master.state === 'Booted') {
        await this.manager.shutdown(master.udid);
      }

      // 3. Clone. `simctl clone <source> <new-name>` emits the new UDID on stdout.
      const cloneName = `OpenSafari-Pool-${preset}-${Date.now()}`;
      const output = await this.simctl.exec(['clone', master.udid, cloneName]);
      cloneUdid = output.trim();
      if (!cloneUdid || !/^[0-9A-F-]{20,}$/i.test(cloneUdid)) {
        throw new Error(`SimPool: simctl clone returned unexpected output: "${output}"`);
      }

      // 4. Boot the clone.
      await this.simctl.exec(['boot', cloneUdid]);

      // 5. Wait for Booted state (fast — clones inherit their source snapshot).
      await this.waitForBootedState(cloneUdid);

      // 6. Optional: strip unnecessary background services to shave RAM.
      if (this.disableServices) {
        try {
          await disableBackgroundServices(this.simctl, cloneUdid);
        } catch (err) {
          console.error(`[sim-pool] disableBackgroundServices failed for ${cloneUdid}: ${err}`);
        }
      }

      const pooled: PooledSimulator = {
        udid: cloneUdid,
        preset,
        name: cloneName,
        acquiredAt: Date.now(),
        keepOnRelease: options?.keepOnRelease,
      };
      this.clones.set(cloneUdid, pooled);
      return pooled;
    } catch (err) {
      // Best-effort cleanup on failure
      if (cloneUdid) {
        try {
          await this.simctl.exec(['delete', cloneUdid]);
        } catch {
          /* ignore */
        }
      }
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Release a clone back to the pool. Shuts it down and (unless
   * `keepOnRelease` is set) deletes it so RAM and disk are reclaimed.
   * Returns false if the UDID was not managed by this pool.
   */
  async release(udid: string): Promise<boolean> {
    const pooled = this.clones.get(udid);
    if (!pooled) return false;

    this.clones.delete(udid);

    try {
      await this.manager.shutdown(udid);
    } catch (err) {
      console.error(`[sim-pool] shutdown failed for ${udid}: ${err}`);
    }

    if (!pooled.keepOnRelease) {
      try {
        await this.simctl.exec(['delete', udid]);
      } catch (err) {
        console.error(`[sim-pool] delete failed for ${udid}: ${err}`);
      }
    }

    return true;
  }

  /**
   * Release every managed clone. Used by process shutdown and tests.
   */
  async shutdown(): Promise<void> {
    const udids = Array.from(this.clones.keys());
    for (const udid of udids) {
      await this.release(udid);
    }
  }

  private getLockForPreset(preset: string): AsyncMutex {
    let lock = this.perPresetLocks.get(preset);
    if (!lock) {
      lock = new AsyncMutex();
      this.perPresetLocks.set(preset, lock);
    }
    return lock;
  }

  private async waitForBootedState(udid: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const device: SimulatorDevice | null = await this.manager.getDevice(udid);
      if (device?.state === 'Booted') return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`SimPool: clone ${udid} did not reach Booted state within ${timeoutMs}ms`);
  }
}

// ── Module-level singleton ────────────────────────────────────────────

let shared: SimPool | null = null;

export function getSimPool(): SimPool {
  if (!shared) shared = new SimPool();
  return shared;
}

/** Test helper — drop the shared pool without touching any running clones. */
export function resetSimPoolForTests(): void {
  shared = null;
}
