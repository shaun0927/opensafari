/**
 * Unit tests for memory-tracker (#554).
 */

import {
  recordMemorySample,
  getMemorySnapshot,
  resetMemoryTracker,
  bytesToMB,
  OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV,
} from '../../src/metrics/memory-tracker';

describe('memory-tracker', () => {
  beforeEach(() => {
    resetMemoryTracker();
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV];
  });

  afterEach(() => {
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV];
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

  test('recordMemorySample + memory field extraction < 50 µs per call (microbench)', () => {
    const iterations = 10_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      recordMemorySample();
      const usage = process.memoryUsage();
      // Mirror the same bytesToMB conversions done in timedInput.
      void bytesToMB(usage.rss);
      void bytesToMB(usage.heapUsed);
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const perCallUs = elapsedNs / iterations / 1_000;
    // Allow generous headroom for CI machines; the budget is 50 µs / call.
    expect(perCallUs).toBeLessThan(50);
  });
});
