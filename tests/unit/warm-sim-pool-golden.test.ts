/**
 * Unit tests for PR10 — WarmSimPool golden-device seeding.
 *
 * Verifies:
 *   - warmUp(preset, count, { seedFrom }) forwards masterUdid to SimPool.acquire
 *   - useGoldenDevice + getGoldenDevice round-trip via SimPool.setMaster/getMaster
 *   - acquire/replenish honour the bound golden device when seedFrom is not supplied per call
 */

import { WarmSimPool } from '../../src/simulator/warm-sim-pool';

function makeFakeSimPool() {
  const acquireMock = jest.fn();
  const setMasterMock = jest.fn();
  const getMasterMock = jest.fn();
  const releaseMock = jest.fn().mockResolvedValue(true);
  const shutdownMock = jest.fn().mockResolvedValue(undefined);

  const masters = new Map<string, string>();
  setMasterMock.mockImplementation((preset: string, udid: string | null) => {
    if (udid === null) masters.delete(preset);
    else masters.set(preset, udid);
  });
  getMasterMock.mockImplementation((preset: string) => masters.get(preset) ?? null);

  let cloneCounter = 0;
  acquireMock.mockImplementation(async (preset: string, opts?: { masterUdid?: string }) => {
    cloneCounter++;
    return {
      udid: `CLONE-${cloneCounter}`,
      preset,
      seededFrom: opts?.masterUdid ?? masters.get(preset) ?? null,
    };
  });

  return {
    acquire: acquireMock,
    setMaster: setMasterMock,
    getMaster: getMasterMock,
    release: releaseMock,
    shutdown: shutdownMock,
  };
}

describe('WarmSimPool golden-device seeding', () => {
  it('useGoldenDevice + getGoldenDevice round-trip via SimPool.setMaster/getMaster', () => {
    const base = makeFakeSimPool();
    const pool = new WarmSimPool({ basePool: base as never });

    expect(pool.getGoldenDevice('iphone-16')).toBeNull();
    pool.useGoldenDevice('iphone-16', 'GOLDEN-UDID');
    expect(pool.getGoldenDevice('iphone-16')).toBe('GOLDEN-UDID');
    expect(base.setMaster).toHaveBeenCalledWith('iphone-16', 'GOLDEN-UDID');

    pool.useGoldenDevice('iphone-16', null);
    expect(pool.getGoldenDevice('iphone-16')).toBeNull();
  });

  it('warmUp { seedFrom } forwards masterUdid per acquire', async () => {
    const base = makeFakeSimPool();
    const pool = new WarmSimPool({ basePool: base as never, defaultWarmTarget: 0 });

    await pool.warmUp('iphone-16', 2, { seedFrom: 'GOLDEN-UDID' });

    expect(base.acquire).toHaveBeenCalledTimes(2);
    expect(base.acquire).toHaveBeenCalledWith('iphone-16', { masterUdid: 'GOLDEN-UDID' });
    expect(pool.warmCountFor('iphone-16')).toBe(2);
  });

  it('subsequent acquire honours the bound golden device when seedFrom was set via useGoldenDevice', async () => {
    const base = makeFakeSimPool();
    const pool = new WarmSimPool({ basePool: base as never, defaultWarmTarget: 0 });

    pool.useGoldenDevice('iphone-16', 'GOLDEN-UDID');

    const clone = (await pool.acquire('iphone-16')) as unknown as { seededFrom: string | null };
    // Fake SimPool surfaces the resolved source via clone.seededFrom — that
    // comes from the per-acquire masterUdid OR the bound master. Since we
    // didn't pass `masterUdid` and the warm pool has no acquire-level
    // seedFrom (yet), the bound master should still apply via SimPool's
    // own resolution. The clone payload should reflect that.
    expect(clone.seededFrom).toBe('GOLDEN-UDID');
  });

  it('warmUp without seedFrom does NOT pass masterUdid (delegating to SimPool resolution)', async () => {
    const base = makeFakeSimPool();
    const pool = new WarmSimPool({ basePool: base as never, defaultWarmTarget: 0 });

    await pool.warmUp('iphone-16', 1);

    // No seedFrom → no masterUdid option object on the acquire call.
    expect(base.acquire).toHaveBeenCalledWith('iphone-16', undefined);
  });
});
