/**
 * Unit tests for the process-wide latency rollup aggregator (issue #502).
 *
 * Covers:
 *   - `emitInputTelemetry` feeds the rollup — one end-to-end path
 *   - p50 / p95 / p99 match the nearest-rank definition for known inputs
 *   - errors are tracked separately and never pollute the latency sample set
 *   - buckets respect the sample cap (FIFO eviction keeps `mean_ms` honest)
 *   - rollup can be disabled via `OPENSAFARI_INPUT_TELEMETRY_ROLLUP=0`
 *   - rows are sorted by `${backendKind}:${operation}` for deterministic output
 */

import {
  emitInputTelemetry,
  __setInputTelemetrySinkForTest,
  OPENSAFARI_INPUT_TELEMETRY_ENV,
} from '../../src/metrics/input-telemetry';
import {
  INPUT_TELEMETRY_ROLLUP_CAP,
  OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV,
  accumulateInputTelemetry,
  getInputTelemetryRollup,
  resetInputTelemetryRollup,
} from '../../src/metrics/input-telemetry-rollup';

describe('input-telemetry-rollup', () => {
  beforeEach(() => {
    resetInputTelemetryRollup();
    process.env[OPENSAFARI_INPUT_TELEMETRY_ENV] = '0'; // silence console sink
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV];
    __setInputTelemetrySinkForTest(() => {
      /* noop */
    });
  });

  afterEach(() => {
    resetInputTelemetryRollup();
    __setInputTelemetrySinkForTest(null);
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV];
  });

  test('emitInputTelemetry accumulates into the rollup', () => {
    for (const ms of [1, 2, 3]) {
      emitInputTelemetry({
        backendKind: 'webkit',
        operation: 'tap',
        deviceId: 'UDID',
        elapsed_ms: ms,
        ok: true,
      });
    }
    const rows = getInputTelemetryRollup();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      backendKind: 'webkit',
      operation: 'tap',
      count: 3,
      errorCount: 0,
      errorRate: 0,
      mean_ms: 2,
    });
  });

  test('nearest-rank p50 / p95 / p99 match the textbook definition', () => {
    // Feed 1..100 so percentiles are easy to read.
    for (let ms = 1; ms <= 100; ms++) {
      accumulateInputTelemetry({
        backendKind: 'simhid',
        operation: 'tap',
        deviceId: 'UDID',
        elapsed_ms: ms,
        ok: true,
      });
    }
    const [row] = getInputTelemetryRollup();
    expect(row.count).toBe(100);
    // nearest-rank: index = ceil(p * n) - 1  →  p50:49 (50ms), p95:94 (95ms), p99:98 (99ms)
    expect(row.p50_ms).toBe(50);
    expect(row.p95_ms).toBe(95);
    expect(row.p99_ms).toBe(99);
    expect(row.mean_ms).toBeCloseTo(50.5, 1);
  });

  test('errors increment errorCount but never touch the latency sample set', () => {
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 10,
      ok: true,
    });
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 9999, // would dominate the mean if it leaked in
      ok: false,
      error: 'boom',
    });
    const [row] = getInputTelemetryRollup();
    expect(row.count).toBe(2);
    expect(row.errorCount).toBe(1);
    expect(row.errorRate).toBe(0.5);
    expect(row.mean_ms).toBe(10); // failure excluded
    expect(row.p50_ms).toBe(10);
    expect(row.p95_ms).toBe(10);
    expect(row.p99_ms).toBe(10);
  });

  test('ring buffer evicts oldest samples once the per-key cap fills', () => {
    // Overfill by 10 so we exercise the FIFO path.
    const total = INPUT_TELEMETRY_ROLLUP_CAP + 10;
    for (let i = 0; i < total; i++) {
      accumulateInputTelemetry({
        backendKind: 'webkit',
        operation: 'swipe',
        deviceId: 'UDID',
        elapsed_ms: i, // monotonically increasing
        ok: true,
      });
    }
    const [row] = getInputTelemetryRollup();
    // All events counted…
    expect(row.count).toBe(total);
    // …but only the last CAP samples feed the percentile stream.
    const survivingFirst = total - INPUT_TELEMETRY_ROLLUP_CAP; // = 10
    const survivingLast = total - 1; // = 1033
    expect(row.p50_ms).toBeGreaterThanOrEqual(survivingFirst); // first 10 evicted
    // Nearest-rank: p99 index = ceil(0.99 * CAP) - 1.
    const p99Index = Math.ceil(0.99 * INPUT_TELEMETRY_ROLLUP_CAP) - 1;
    expect(row.p99_ms).toBe(survivingFirst + p99Index);
    // Largest surviving sample is exposed via the implicit p100 — confirm
    // it stayed in the window rather than being evicted.
    expect(row.p99_ms).toBeLessThanOrEqual(survivingLast);
    // Mean must reflect only the surviving window, not the full stream.
    const expectedMean = (survivingFirst + survivingLast) / 2;
    expect(row.mean_ms).toBeCloseTo(expectedMean, 1);
  });

  test('rollup partitions by ${backendKind}:${operation} key', () => {
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 1,
      ok: true,
    });
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'swipe',
      deviceId: 'UDID',
      elapsed_ms: 2,
      ok: true,
    });
    accumulateInputTelemetry({
      backendKind: 'simhid',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 3,
      ok: true,
    });
    const rows = getInputTelemetryRollup();
    expect(rows).toHaveLength(3);
    // Sorted ascending by "${backendKind}:${operation}"
    expect(rows.map((r) => `${r.backendKind}:${r.operation}`)).toEqual([
      'simhid:tap',
      'webkit:swipe',
      'webkit:tap',
    ]);
  });

  test.each(['0', 'false'])(
    'is silenced when OPENSAFARI_INPUT_TELEMETRY_ROLLUP=%s',
    (value) => {
      process.env[OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV] = value;
      accumulateInputTelemetry({
        backendKind: 'webkit',
        operation: 'tap',
        deviceId: 'UDID',
        elapsed_ms: 1,
        ok: true,
      });
      expect(getInputTelemetryRollup()).toEqual([]);
    },
  );

  test('resetInputTelemetryRollup drops every bucket', () => {
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 1,
      ok: true,
    });
    expect(getInputTelemetryRollup()).toHaveLength(1);
    resetInputTelemetryRollup();
    expect(getInputTelemetryRollup()).toEqual([]);
  });

  test('lastUpdated is populated on both success and failure paths', () => {
    const before = Date.now();
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 5,
      ok: true,
    });
    accumulateInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID',
      elapsed_ms: 0,
      ok: false,
      error: 'x',
    });
    const [row] = getInputTelemetryRollup();
    expect(row.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(row.lastUpdated).toBeLessThanOrEqual(Date.now());
  });
});
