/**
 * Process-wide latency rollup for input-backend telemetry (issue #502).
 *
 * Every event emitted through `emitInputTelemetry` is also accumulated here
 * so callers can ask for per-(backendKind, operation) p50/p95/p99 latency
 * without scraping stderr. The rollup is a thin nearest-rank percentile
 * over a bounded ring buffer — a good-enough approximation that matches
 * Epic #484's reliability AC ("평균 / p95 / p99 latency가 telemetry로
 * 수집됨") without pulling in a t-digest dependency.
 *
 * Memory bound: `INPUT_TELEMETRY_ROLLUP_CAP` samples per key (default 1024),
 * evicted FIFO once full. Keys are `${backendKind}:${operation}`. Errors
 * (`ok: false`) are tracked separately so `errorRate` stays meaningful even
 * when the elapsed-ms stream is dominated by failures.
 */

import type { InputBackendKind } from '../input/backend';
import type { InputOperation, InputTelemetryEvent } from './input-telemetry';

/** Max samples retained per `${backendKind}:${operation}` key. */
export const INPUT_TELEMETRY_ROLLUP_CAP = 1024;

/**
 * Env var that disables the rollup accumulator. Unlike the console sink flag
 * (`OPENSAFARI_INPUT_TELEMETRY`) this one defaults to on because aggregation
 * is O(1) per event — we only pay work when callers request a snapshot.
 */
export const OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV = 'OPENSAFARI_INPUT_TELEMETRY_ROLLUP';

/** One row of the `{backendKind, operation}` summary table. */
export interface InputTelemetryRollup {
  backendKind: InputBackendKind;
  operation: InputOperation;
  count: number;
  errorCount: number;
  /** `errorCount / count`, clamped to [0, 1]. `0` when `count === 0`. */
  errorRate: number;
  /** Arithmetic mean of `elapsed_ms` across **successful** calls. */
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  /** Wall-clock epoch ms of the most recent sample (success or failure). */
  lastUpdated: number;
  /** Median RSS in MB across successful calls that reported memory. `0` when none. */
  p50_rss_mb: number;
  /** 95th-percentile RSS in MB across successful calls that reported memory. `0` when none. */
  p95_rss_mb: number;
  /** Maximum RSS in MB observed across successful calls that reported memory. `0` when none. */
  max_rss_mb: number;
}

interface Bucket {
  samples: number[]; // ring buffer of elapsed_ms for successful calls
  start: number; // ring buffer head offset
  size: number; // samples actually populated
  count: number; // total events observed (success + failure)
  errorCount: number;
  sum: number; // running sum of successful elapsed_ms (for mean)
  lastUpdated: number;
  rssSamples: number[]; // ring buffer of rss_mb for successful calls that reported memory
  rssStart: number; // ring buffer head offset for RSS
  rssSize: number; // RSS samples actually populated
}

const buckets = new Map<string, Bucket>();

function key(backendKind: InputBackendKind, operation: InputOperation): string {
  return `${backendKind}:${operation}`;
}

function isRollupEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_ROLLUP_ENV];
  return value !== '0' && value !== 'false';
}

function newBucket(): Bucket {
  return {
    samples: new Array<number>(INPUT_TELEMETRY_ROLLUP_CAP),
    start: 0,
    size: 0,
    count: 0,
    errorCount: 0,
    sum: 0,
    lastUpdated: 0,
    rssSamples: new Array<number>(INPUT_TELEMETRY_ROLLUP_CAP),
    rssStart: 0,
    rssSize: 0,
  };
}

/**
 * Append one event to the rollup accumulator. Safe to call with any shape
 * the telemetry pipeline can emit — unknown backend/operation labels create
 * a new bucket. No-op when rollup is disabled.
 */
export function accumulateInputTelemetry(event: InputTelemetryEvent): void {
  if (!isRollupEnabled()) return;
  const k = key(event.backendKind, event.operation);
  let b = buckets.get(k);
  if (!b) {
    b = newBucket();
    buckets.set(k, b);
  }
  b.count += 1;
  b.lastUpdated = Date.now();
  if (!event.ok) {
    b.errorCount += 1;
    return;
  }
  const ms = event.elapsed_ms;
  if (b.size < INPUT_TELEMETRY_ROLLUP_CAP) {
    b.samples[(b.start + b.size) % INPUT_TELEMETRY_ROLLUP_CAP] = ms;
    b.size += 1;
    b.sum += ms;
  } else {
    // Evict the oldest sample (FIFO) and replace it.
    const evicted = b.samples[b.start];
    b.samples[b.start] = ms;
    b.start = (b.start + 1) % INPUT_TELEMETRY_ROLLUP_CAP;
    b.sum += ms - evicted;
  }
  // Accumulate RSS sample when the event carries memory fields.
  if (event.rss_mb !== undefined) {
    const rss = event.rss_mb;
    if (b.rssSize < INPUT_TELEMETRY_ROLLUP_CAP) {
      b.rssSamples[(b.rssStart + b.rssSize) % INPUT_TELEMETRY_ROLLUP_CAP] = rss;
      b.rssSize += 1;
    } else {
      b.rssSamples[b.rssStart] = rss;
      b.rssStart = (b.rssStart + 1) % INPUT_TELEMETRY_ROLLUP_CAP;
    }
  }
}

/** Nearest-rank percentile — simple and stable for small/medium samples. */
function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  // Nearest-rank: index = ceil(p * n) - 1, floored at 0.
  const idx = Math.max(0, Math.ceil(clamped * sortedAscending.length) - 1);
  return sortedAscending[idx];
}

function snapshotBucket(
  backendKind: InputBackendKind,
  operation: InputOperation,
  b: Bucket,
): InputTelemetryRollup {
  const successCount = b.size;
  const sorted: number[] = new Array(successCount);
  for (let i = 0; i < successCount; i++) {
    sorted[i] = b.samples[(b.start + i) % INPUT_TELEMETRY_ROLLUP_CAP];
  }
  sorted.sort((a, x) => a - x);
  const mean = successCount === 0 ? 0 : b.sum / successCount;

  // Compute RSS percentiles from the RSS ring buffer.
  const rssSorted: number[] = new Array(b.rssSize);
  for (let i = 0; i < b.rssSize; i++) {
    rssSorted[i] = b.rssSamples[(b.rssStart + i) % INPUT_TELEMETRY_ROLLUP_CAP];
  }
  rssSorted.sort((a, x) => a - x);

  return {
    backendKind,
    operation,
    count: b.count,
    errorCount: b.errorCount,
    errorRate: b.count === 0 ? 0 : b.errorCount / b.count,
    mean_ms: Math.round(mean * 100) / 100,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    lastUpdated: b.lastUpdated,
    p50_rss_mb: percentile(rssSorted, 0.5),
    p95_rss_mb: percentile(rssSorted, 0.95),
    max_rss_mb: rssSorted.length > 0 ? rssSorted[rssSorted.length - 1] : 0,
  };
}

/**
 * Return the rollup snapshot. Stable ordering: sorted by key ascending so
 * downstream diffs / golden-file tests are deterministic.
 */
export function getInputTelemetryRollup(): InputTelemetryRollup[] {
  const out: InputTelemetryRollup[] = [];
  const keys = Array.from(buckets.keys()).sort();
  for (const k of keys) {
    const [backendKind, operation] = k.split(':') as [InputBackendKind, InputOperation];
    const b = buckets.get(k)!;
    out.push(snapshotBucket(backendKind, operation, b));
  }
  return out;
}

/**
 * Drop every accumulated sample. Tests and long-running daemons that want
 * fresh windows call this at the start of their measurement period.
 */
export function resetInputTelemetryRollup(): void {
  buckets.clear();
}

/**
 * Return the total number of retained latency samples across every bucket.
 * Used by the cache-budget survey (#554) to check this cache's memory
 * footprint against its documented budget in `docs/memory-budget.md`.
 */
export function getInputTelemetryRollupSampleCount(): number {
  let total = 0;
  for (const b of buckets.values()) {
    total += b.size + b.rssSize;
  }
  return total;
}

/** Current number of distinct `${backendKind}:${operation}` buckets. */
export function getInputTelemetryRollupBucketCount(): number {
  return buckets.size;
}
