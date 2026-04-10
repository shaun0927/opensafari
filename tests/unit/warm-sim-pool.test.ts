/**
 * Unit tests for WarmSimPool — the pre-booted clone pool introduced in
 * Phase 4.1 of issue #408.
 */

import { WarmSimPool } from '../../src/simulator/warm-sim-pool';

type FakeClone = { udid: string; preset: string; name: string; acquiredAt: number; keepOnRelease?: boolean };

class FakeBasePool {
  acquire = jest.fn<Promise<FakeClone>, [string, any?]>();
  release = jest.fn<Promise<boolean>, [string]>();
  shutdown = jest.fn<Promise<void>, []>();

  constructor() {
    let counter = 0;
    this.acquire.mockImplementation(async (preset: string, opts?: any) => {
      counter++;
      return {
        udid: `clone-${preset}-${counter}`,
        preset,
        name: `OpenSafari-Pool-${preset}-${counter}`,
        acquiredAt: Date.now(),
        keepOnRelease: opts?.keepOnRelease,
      };
    });
    this.release.mockResolvedValue(true);
    this.shutdown.mockResolvedValue(undefined);
  }
}

const PRESET = 'iphone-se-3';

describe('WarmSimPool', () => {
  let base: FakeBasePool;
  let pool: WarmSimPool;

  beforeEach(() => {
    base = new FakeBasePool();
    pool = new WarmSimPool({ basePool: base as any, defaultWarmTarget: 2 });
  });

  describe('warmUp', () => {
    test('pre-acquires the requested number of clones', async () => {
      await pool.warmUp(PRESET, 3);

      expect(base.acquire).toHaveBeenCalledTimes(3);
      expect(pool.warmCountFor(PRESET)).toBe(3);
      expect(pool.warmSize).toBe(3);
    });

    test('uses the default target when count is omitted', async () => {
      await pool.warmUp(PRESET);

      expect(base.acquire).toHaveBeenCalledTimes(2); // defaultWarmTarget = 2
      expect(pool.warmCountFor(PRESET)).toBe(2);
    });

    test('skips when the pool is already full', async () => {
      await pool.warmUp(PRESET, 2);
      base.acquire.mockClear();

      await pool.warmUp(PRESET, 2);

      expect(base.acquire).not.toHaveBeenCalled();
    });

    test('partial failure does not prevent other warm clones', async () => {
      base.acquire.mockImplementationOnce(async () => {
        throw new Error('boot failed');
      });

      await pool.warmUp(PRESET, 3);

      // 2 of 3 succeeded
      expect(pool.warmCountFor(PRESET)).toBe(2);
    });
  });

  describe('acquire', () => {
    test('returns a warm clone and triggers background replenish', async () => {
      await pool.warmUp(PRESET, 2);
      base.acquire.mockClear();

      const clone = await pool.acquire(PRESET);
      expect(clone).toBeDefined();

      // Background replenish kicks in asynchronously. Flush the microtask
      // queue a couple of times so the async loop completes.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Replenish should have topped the queue back to the target
      expect(pool.warmCountFor(PRESET)).toBe(2);
      // Exactly one replenish acquire happened (to replace the one we took)
      expect(base.acquire).toHaveBeenCalledTimes(1);
    });

    test('falls back to base.acquire when the warm queue is empty', async () => {
      const clone = await pool.acquire(PRESET);

      expect(clone).toBeDefined();
      expect(base.acquire).toHaveBeenCalled();
    });

    test('propagates keepOnRelease on warm clones', async () => {
      await pool.warmUp(PRESET, 1);

      const clone = await pool.acquire(PRESET, { keepOnRelease: true });
      expect(clone.keepOnRelease).toBe(true);
    });

    test('multiple concurrent warm hits deplete the queue correctly', async () => {
      await pool.warmUp(PRESET, 3);
      base.acquire.mockClear();

      const [c1, c2, c3] = await Promise.all([
        pool.acquire(PRESET),
        pool.acquire(PRESET),
        pool.acquire(PRESET),
      ]);

      expect(new Set([c1.udid, c2.udid, c3.udid]).size).toBe(3);
    });
  });

  describe('replenish', () => {
    test('refills up to the configured target', async () => {
      pool.setWarmTarget(PRESET, 3);
      await pool.replenish(PRESET);
      expect(pool.warmCountFor(PRESET)).toBe(3);
    });

    test('stops and logs on acquire failure', async () => {
      pool.setWarmTarget(PRESET, 3);
      base.acquire.mockRejectedValueOnce(new Error('no free port'));

      await pool.replenish(PRESET);

      // First call failed → replenish returned without adding anything
      expect(pool.warmCountFor(PRESET)).toBe(0);
    });

    test('in-flight lock prevents duplicate work', async () => {
      pool.setWarmTarget(PRESET, 2);
      // Slow down acquires so both calls run in parallel
      let resolveFirst: (v: any) => void = () => {};
      const pending = new Promise<FakeClone>((r) => {
        resolveFirst = r;
      });
      base.acquire.mockImplementationOnce(() => pending);
      base.acquire.mockImplementationOnce(async () => ({
        udid: 'clone-2',
        preset: PRESET,
        name: 'x',
        acquiredAt: 0,
      }));

      const a = pool.replenish(PRESET);
      const b = pool.replenish(PRESET);

      resolveFirst({ udid: 'clone-1', preset: PRESET, name: 'x', acquiredAt: 0 });
      await Promise.all([a, b]);

      // The second call should have been a no-op because the first was in flight
      expect(base.acquire).toHaveBeenCalledTimes(2); // exactly to reach target=2
    });
  });

  describe('setWarmTarget', () => {
    test('rejects negative targets', () => {
      expect(() => pool.setWarmTarget(PRESET, -1)).toThrow(/must be >= 0/);
    });

    test('target=0 disables warming for that preset', async () => {
      pool.setWarmTarget(PRESET, 0);
      await pool.replenish(PRESET);
      expect(pool.warmCountFor(PRESET)).toBe(0);
    });
  });

  describe('shutdown', () => {
    test('releases every ready clone', async () => {
      await pool.warmUp(PRESET, 3);
      expect(pool.warmCountFor(PRESET)).toBe(3);

      await pool.shutdown();

      expect(base.release).toHaveBeenCalledTimes(3);
      expect(pool.warmCountFor(PRESET)).toBe(0);
      expect(base.shutdown).toHaveBeenCalled();
    });
  });

  describe('release', () => {
    test('forwards to base.release', async () => {
      const ok = await pool.release('some-udid');
      expect(ok).toBe(true);
      expect(base.release).toHaveBeenCalledWith('some-udid');
    });
  });
});
