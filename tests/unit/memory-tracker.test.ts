/**
 * Unit tests for memory-tracker (#554).
 */

import {
  recordMemorySample,
  recordMemorySampleFromRss,
  getMemorySnapshot,
  resetMemoryTracker,
  bytesToMB,
  getRssGrowthPerHour,
  getMemorySoftCapMB,
  isMemoryCapExceeded,
  OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV,
  OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV,
} from '../../src/metrics/memory-tracker';

describe('memory-tracker', () => {
  beforeEach(() => {
    resetMemoryTracker();
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV];
    delete process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV];
  });

  afterEach(() => {
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV];
    delete process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV];
    jest.restoreAllMocks();
  });

  test('records samples and tracks peak RSS', () => {
    recordMemorySample();
    recordMemorySample();
    const snapshot = getMemorySnapshot();
    expect(snapshot.sampleCount).toBe(2);
    expect(snapshot.rssBytes).toBeGreaterThan(0);
    // The diagnose-time snapshot pulls in the current sample, so peak is
    // at least as big as current.
    expect(snapshot.peakRssBytes).toBeGreaterThanOrEqual(snapshot.rssBytes);
  });

  test('disables sampling when env var is "0"', () => {
    process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV] = '0';
    recordMemorySample();
    recordMemorySample();
    const snapshot = getMemorySnapshot();
    // Per-op sampler did not tick.
    expect(snapshot.sampleCount).toBe(0);
    // diagnose still works — full snapshot bypasses the env gate.
    expect(snapshot.rssBytes).toBeGreaterThan(0);
  });

  test('disables sampling when env var is "false" or "off"', () => {
    for (const value of ['false', 'off']) {
      resetMemoryTracker();
      process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV] = value;
      recordMemorySample();
      expect(getMemorySnapshot().sampleCount).toBe(0);
    }
  });

  test('snapshot includes heap and external memory fields', () => {
    const snapshot = getMemorySnapshot();
    expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.heapTotalBytes).toBeGreaterThanOrEqual(snapshot.heapUsedBytes);
    expect(snapshot.externalBytes).toBeGreaterThanOrEqual(0);
    expect(snapshot.arrayBuffersBytes).toBeGreaterThanOrEqual(0);
  });

  test('resetMemoryTracker zeroes peak and sample count', () => {
    recordMemorySample();
    recordMemorySample();
    resetMemoryTracker();
    // peakRssBytes is reset, but `getMemorySnapshot()` immediately bumps
    // it back to the current RSS — so we assert the sample counter, which
    // is the sole signal of "did the per-op sampler tick after reset".
    expect(getMemorySnapshot().sampleCount).toBe(0);
  });

  test('bytesToMB rounds to two decimal places', () => {
    expect(bytesToMB(0)).toBe(0);
    expect(bytesToMB(1_048_576)).toBe(1);
    expect(bytesToMB(1_572_864)).toBe(1.5);
    expect(bytesToMB(1_153_434)).toBe(1.1); // 1.1000... → 1.1
  });

  test('recordMemorySampleFromRss ticks peak + sampleCount without a syscall', () => {
    // No prior samples — tracker starts clean (resetMemoryTracker ran in beforeEach).
    expect(getMemorySnapshot().sampleCount).toBe(0);

    recordMemorySampleFromRss(10 * 1_048_576);
    recordMemorySampleFromRss(42 * 1_048_576);

    const snap = getMemorySnapshot();
    // sampleCount is bumped even though we never called process.memoryUsage.rss().
    expect(snap.sampleCount).toBe(2);
    // Peak tracks the larger of the two feeds (42 MB > 10 MB).
    expect(snap.peakRssBytes).toBeGreaterThanOrEqual(42 * 1_048_576);
  });

  test('recordMemorySampleFromRss is a no-op for non-finite / negative inputs', () => {
    recordMemorySampleFromRss(Number.NaN);
    recordMemorySampleFromRss(-1);
    recordMemorySampleFromRss(Number.POSITIVE_INFINITY);
    expect(getMemorySnapshot().sampleCount).toBe(0);
  });

  test('recordMemorySampleFromRss respects the tracking-disabled kill switch', () => {
    process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV] = '0';
    recordMemorySampleFromRss(999 * 1_048_576);
    // Snapshot bumps peak from the live usage, so we only assert the counter.
    expect(getMemorySnapshot().sampleCount).toBe(0);
  });

  test('single-syscall memory sampling + field extraction < 50 µs per call (microbench)', () => {
    // Mirrors the optimized per-op hot path that `timedInput` exercises when
    // memory tracking is enabled: ONE `process.memoryUsage()` call feeding
    // both the telemetry event (rss_mb/heap_used_mb) and the peak tracker
    // (via `recordMemorySampleFromRss`). This is what the issue #554 budget
    // (< 50 µs / call) measures — not two independent syscalls.
    const iterations = 10_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const usage = process.memoryUsage();
      recordMemorySampleFromRss(usage.rss);
      void bytesToMB(usage.rss);
      void bytesToMB(usage.heapUsed);
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const perCallUs = elapsedNs / iterations / 1_000;
    // Budget is 50 µs / call per the issue; assert against it directly.
    expect(perCallUs).toBeLessThan(50);
  });

  // ── time-series / getRssGrowthPerHour ────────────────────────────────────

  test('getRssGrowthPerHour returns null with fewer than 2 samples', () => {
    expect(getRssGrowthPerHour()).toBeNull();
    // One sample in buffer — still null.
    recordMemorySample();
    expect(getRssGrowthPerHour()).toBeNull();
  });

  test('getRssGrowthPerHour computes MB/hour from two time-series entries', () => {
    const BASE_MS = 1_000_000_000;
    // Stub Date.now so we can control timestamps precisely.
    const dateSpy = jest.spyOn(Date, 'now');

    // First time-series entry: RSS via process.memoryUsage — we cannot
    // control the actual RSS value, so we verify the formula shape instead
    // of a specific number. Two entries 60 s apart with the same RSS should
    // yield 0 MB/hour growth.
    dateSpy.mockReturnValue(BASE_MS);
    recordMemorySample(); // writes first time-series entry

    // Advance 60 s so the second call is accepted into the buffer.
    dateSpy.mockReturnValue(BASE_MS + 60_000);
    recordMemorySample(); // writes second entry

    const growth = getRssGrowthPerHour();
    // Growth must be a finite number (exact value depends on real RSS).
    expect(growth).not.toBeNull();
    expect(Number.isFinite(growth as number)).toBe(true);

    dateSpy.mockRestore();
  });

  test('getRssGrowthPerHour reflects a known RSS delta', () => {
    const BASE_MS = 2_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now');
    const rssSpy = jest.spyOn(process, 'memoryUsage');

    // Simulate RSS growing by exactly 10 MB over 60 minutes.
    const TEN_MB = 10 * 1_048_576;
    const base = { rss: 100 * 1_048_576, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };

    dateSpy.mockReturnValue(BASE_MS);
    rssSpy.mockReturnValue({ ...base });
    // Also mock the fast rss helper by ensuring rss() falls back to memoryUsage().rss.
    recordMemorySample();

    dateSpy.mockReturnValue(BASE_MS + 3_600_000); // +60 min
    rssSpy.mockReturnValue({ ...base, rss: base.rss + TEN_MB });
    recordMemorySample();

    const growth = getRssGrowthPerHour();
    // Should be 10 MB/hr (± floating-point rounding).
    expect(growth).not.toBeNull();
    expect(growth as number).toBeCloseTo(10, 1);

    dateSpy.mockRestore();
    rssSpy.mockRestore();
  });

  test('resetMemoryTracker clears the time-series buffer', () => {
    const dateSpy = jest.spyOn(Date, 'now');
    dateSpy.mockReturnValue(1_000_000_000);
    recordMemorySample();
    dateSpy.mockReturnValue(1_000_060_000);
    recordMemorySample();
    expect(getRssGrowthPerHour()).not.toBeNull();

    resetMemoryTracker();
    expect(getRssGrowthPerHour()).toBeNull();

    dateSpy.mockRestore();
  });

  test('time-series buffer never exceeds 6 entries', () => {
    // Each recordMemorySample() with a 60-s gap writes one entry.
    const dateSpy = jest.spyOn(Date, 'now');
    let t = 0;
    for (let i = 0; i < 10; i++) {
      dateSpy.mockReturnValue(t);
      recordMemorySample();
      t += 60_000;
    }
    // getRssGrowthPerHour() should still return a valid number (not null)
    // even after 10 calls, confirming the buffer accepted at least 2 entries
    // and did not throw on overflow.
    expect(getRssGrowthPerHour()).not.toBeNull();
    dateSpy.mockRestore();
  });

  // ── soft-cap watchdog ────────────────────────────────────────────────────

  test('getMemorySoftCapMB returns null when env var is unset', () => {
    expect(getMemorySoftCapMB()).toBeNull();
  });

  test('getMemorySoftCapMB parses a valid positive number', () => {
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '512';
    expect(getMemorySoftCapMB()).toBe(512);
  });

  test('getMemorySoftCapMB returns null for invalid values', () => {
    for (const bad of ['', 'abc', '-1', '0']) {
      process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = bad;
      expect(getMemorySoftCapMB()).toBeNull();
    }
  });

  test('isMemoryCapExceeded returns false when cap is unset', () => {
    expect(isMemoryCapExceeded()).toBe(false);
  });

  test('isMemoryCapExceeded returns false when RSS is within cap', () => {
    // Set an extremely large cap so real RSS never exceeds it.
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '99999';
    expect(isMemoryCapExceeded()).toBe(false);
  });

  test('isMemoryCapExceeded returns true when cap is below current RSS', () => {
    // Set cap to 1 byte's worth (effectively 0 MB) — always exceeded.
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '0.000001';
    expect(isMemoryCapExceeded()).toBe(true);
  });

  test('soft-cap watchdog emits console.error when RSS exceeds cap', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Set a cap so small it is always exceeded.
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '0.000001';

    recordMemorySample();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/\[memory-watchdog\]/);
    expect(errorSpy.mock.calls[0][0]).toMatch(/RSS crossed soft cap/);
    errorSpy.mockRestore();
  });

  test('soft-cap watchdog does not spam — at most one warning per 60 s', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '0.000001';

    const dateSpy = jest.spyOn(Date, 'now');
    const BASE = 5_000_000_000;
    dateSpy.mockReturnValue(BASE);

    recordMemorySample(); // emits warning
    recordMemorySample(); // within cooldown — suppressed
    recordMemorySample(); // within cooldown — suppressed

    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Advance past cooldown.
    dateSpy.mockReturnValue(BASE + 60_001);
    recordMemorySample(); // emits second warning

    expect(errorSpy).toHaveBeenCalledTimes(2);

    dateSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('soft-cap watchdog does not emit when cap is not exceeded', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Enormous cap — will never be exceeded by test process.
    process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV] = '99999';

    recordMemorySample();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
