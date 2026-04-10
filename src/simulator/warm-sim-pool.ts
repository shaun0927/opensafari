/**
 * WarmSimPool — Pre-booted clone pool wrapping `SimPool`.
 *
 * The base `SimPool` (Phase 2B.2 of #408) already makes `acquire` fast by
 * using `simctl clone` (~2 s) instead of cold boot (~20 s). WarmSimPool
 * pushes that further: it keeps N clones **pre-acquired** in a ready
 * queue so typical `acquire()` calls return in essentially zero time.
 *
 * Lifecycle:
 *   1. `warmUp(preset, count?)` pre-acquires up to `count` clones of a
 *      preset and parks them in the ready queue.
 *   2. `acquire(preset)` pulls one ready clone out of the queue if any
 *      match the preset; otherwise falls back to the base SimPool.
 *   3. `release(udid)` forwards to the base SimPool (which shuts down
 *      and deletes the clone).
 *   4. Every `acquire` triggers a non-blocking background `replenish()`
 *      so the queue refills up to `warmTargets[preset]`.
 *
 * Configuration:
 *   - `OPENSAFARI_WARM_POOL_SIZE` (default 1) — default warm target
 *     for every preset. Applied the first time a preset is observed.
 *
 * The warm pool is orthogonal to `SimPool`'s `maxClones` cap: warm
 * clones count toward the cap, so raise both together in high-
 * concurrency environments.
 *
 * Phase 4.1 of #408.
 */

import { SimPool, PooledSimulator } from './sim-pool';

const DEFAULT_WARM_POOL_SIZE = 1;

function defaultWarmTarget(): number {
  const raw = process.env.OPENSAFARI_WARM_POOL_SIZE;
  if (!raw) return DEFAULT_WARM_POOL_SIZE;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WARM_POOL_SIZE;
}

export interface WarmSimPoolOptions {
  /** Optional override for an existing base pool. */
  basePool?: SimPool;
  /** Default warm target for any preset not explicitly configured. */
  defaultWarmTarget?: number;
}

/**
 * A per-preset FIFO queue of ready-to-hand-out clones.
 */
export class WarmSimPool {
  private readonly base: SimPool;
  private readonly ready: Map<string, PooledSimulator[]> = new Map();
  private readonly warmTargets: Map<string, number> = new Map();
  private readonly defaultTarget: number;
  /** In-flight replenish promises, so we don't kick off duplicate work. */
  private readonly replenishInFlight: Set<string> = new Set();

  constructor(options?: WarmSimPoolOptions) {
    this.base = options?.basePool ?? new SimPool();
    this.defaultTarget = options?.defaultWarmTarget ?? defaultWarmTarget();
  }

  /** Number of clones currently idle in the warm queue. */
  get warmSize(): number {
    let total = 0;
    for (const arr of this.ready.values()) total += arr.length;
    return total;
  }

  /** Warm count for a specific preset. */
  warmCountFor(preset: string): number {
    return this.ready.get(preset)?.length ?? 0;
  }

  /**
   * Set the desired warm target for a specific preset. Replenishment
   * runs in the background until the pool reaches this count.
   */
  setWarmTarget(preset: string, target: number): void {
    if (target < 0) {
      throw new Error(`warm target must be >= 0 (got ${target})`);
    }
    this.warmTargets.set(preset, target);
  }

  /**
   * Pre-acquire clones so that the pool reaches the requested warm
   * target for `preset`. Called explicitly at startup or lazily on
   * first `acquire`. Resolves once all clones have been booted.
   */
  async warmUp(preset: string, count?: number): Promise<void> {
    const target = count ?? this.targetFor(preset);
    this.warmTargets.set(preset, target);
    const missing = target - this.warmCountFor(preset);
    if (missing <= 0) return;

    const results = await Promise.allSettled(
      Array.from({ length: missing }, () => this.base.acquire(preset)),
    );
    const bucket = this.ready.get(preset) ?? [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        bucket.push(r.value);
      } else {
        console.error(`[warm-sim-pool] warmUp failed for ${preset}: ${r.reason}`);
      }
    }
    this.ready.set(preset, bucket);
  }

  /**
   * Acquire a simulator for the preset. Returns a ready clone from the
   * warm queue when available; otherwise falls back to `SimPool.acquire`.
   * Triggers a background replenish so the queue refills.
   */
  async acquire(preset: string, options?: { keepOnRelease?: boolean }): Promise<PooledSimulator> {
    const bucket = this.ready.get(preset);
    let clone: PooledSimulator;
    if (bucket && bucket.length > 0) {
      // Warm hit — no boot latency
      clone = bucket.shift()!;
      if (options?.keepOnRelease) {
        clone.keepOnRelease = true;
      }
    } else {
      clone = await this.base.acquire(preset, options);
    }

    // Kick off replenish without awaiting so the caller gets their clone
    // immediately. Errors are logged, not thrown.
    void this.replenish(preset).catch((err) => {
      console.error(`[warm-sim-pool] background replenish failed for ${preset}: ${err}`);
    });

    return clone;
  }

  /**
   * Refill the warm queue for `preset` up to its target. Safe to call
   * concurrently — a per-preset in-flight flag prevents duplicate work.
   */
  async replenish(preset: string): Promise<void> {
    if (this.replenishInFlight.has(preset)) return;
    this.replenishInFlight.add(preset);
    try {
      const target = this.targetFor(preset);
      while (this.warmCountFor(preset) < target) {
        let clone: PooledSimulator;
        try {
          clone = await this.base.acquire(preset);
        } catch (err) {
          console.error(`[warm-sim-pool] replenish acquire failed for ${preset}: ${err}`);
          return; // Stop refilling on failure; user can retry later
        }
        const bucket = this.ready.get(preset) ?? [];
        bucket.push(clone);
        this.ready.set(preset, bucket);
      }
    } finally {
      this.replenishInFlight.delete(preset);
    }
  }

  /**
   * Release a clone back to the underlying SimPool. Warm clones are
   * NOT recycled because they may be in a dirty state (cookies, DOM,
   * app launches) after the caller used them; we delete and re-create
   * instead so each acquire gets a clean snapshot.
   */
  async release(udid: string): Promise<boolean> {
    return this.base.release(udid);
  }

  /**
   * Shut down the warm pool: delete every ready clone and tear down
   * the base pool. Used by process exit and tests.
   */
  async shutdown(): Promise<void> {
    for (const [, bucket] of this.ready) {
      while (bucket.length > 0) {
        const clone = bucket.shift()!;
        try {
          await this.base.release(clone.udid);
        } catch (err) {
          console.error(`[warm-sim-pool] release-on-shutdown failed for ${clone.udid}: ${err}`);
        }
      }
    }
    this.ready.clear();
    this.warmTargets.clear();
    this.replenishInFlight.clear();
    await this.base.shutdown();
  }

  private targetFor(preset: string): number {
    return this.warmTargets.get(preset) ?? this.defaultTarget;
  }
}

// ── Module-level singleton ────────────────────────────────────────────

let shared: WarmSimPool | null = null;

export function getWarmSimPool(): WarmSimPool {
  if (!shared) shared = new WarmSimPool();
  return shared;
}

/** Test helper — drop the shared instance. */
export function resetWarmSimPoolForTests(): void {
  shared = null;
}
