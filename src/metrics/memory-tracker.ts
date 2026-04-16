/**
 * Process-wide memory tracker — first slice of issue #554's memory SLO plan.
 *
 * The OpenSafari MCP server typically runs as a long-lived process inside an
 * AI agent's session: hours of tool calls against the same simulator, many
 * cached WebKit / AX / VM client references. Today we have no holistic
 * guard that would surface a slow leak before the kernel kills the process.
 *
 * This module is the cheapest possible first step: a shared singleton that
 * remembers the peak `process.memoryUsage.rss()` value seen across every
 * input-backend call, and a full-snapshot API used by the `diagnose` tool.
 * The per-call sampler is deliberately tiny (< 1 µs on macOS when the fast
 * RSS-only variant is available) so it can safely ride on top of every
 * `timedInput` invocation without a measurable latency impact.
 *
 * This module also provides:
 *   - A circular buffer of RSS time-series samples (6 slots, ≥60 s apart)
 *     used to compute an MB/hour growth rate via `getRssGrowthPerHour()`.
 *   - A soft-cap watchdog driven by `OPENSAFARI_MEMORY_SOFT_CAP_MB` that
 *     emits a rate-limited `console.error` when RSS exceeds the cap.
 */

/**
 * Env var that disables memory sampling on the hot path. `1` / `true` /
 * `on` leaves sampling enabled (the default). Any other value disables it.
 *
 * The tracker is default-on because `process.memoryUsage.rss()` is a
 * single syscall on macOS / Linux and costs less than the surrounding
 * `timedInput` wrapper overhead. The kill-switch exists mainly for
 * regression-testing the rest of the telemetry pipeline in isolation.
 */
export const OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV =
  'OPENSAFARI_INPUT_TELEMETRY_MEMORY';

/**
 * Env var for the optional memory soft-cap watchdog. When set to a positive
 * integer (MB), `recordMemorySample()` emits a rate-limited `console.error`
 * warning whenever the process RSS exceeds this threshold.
 *
 * Example: `OPENSAFARI_MEMORY_SOFT_CAP_MB=512`
 */
export const OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV = 'OPENSAFARI_MEMORY_SOFT_CAP_MB';

export interface MemorySnapshot {
  /** Current resident set size in bytes. */
  rssBytes: number;
  /** Peak RSS observed since process start (or last `resetMemoryTracker`). */
  peakRssBytes: number;
  /** V8 heap used at snapshot time. */
  heapUsedBytes: number;
  /** V8 heap total capacity at snapshot time. */
  heapTotalBytes: number;
  /** Off-heap memory used by C++ objects bound to JS. */
  externalBytes: number;
  /** `ArrayBuffer` / `SharedArrayBuffer` allocations attributed to V8. */
  arrayBuffersBytes: number;
  /**
   * Number of RSS samples the tracker has observed. Useful in tests to
   * assert that `recordMemorySample()` is actually being called from the
   * telemetry path.
   */
  sampleCount: number;
}

/** One slot in the RSS time-series circular buffer. */
interface RssSample {
  rssBytes: number;
  timestampMs: number;
}

// ── module-level state ────────────────────────────────────────────────────────

let peakRssBytes = 0;
let sampleCount = 0;

/** Circular buffer of up to 6 RSS time-series entries spaced ≥ 60 s apart. */
const RSS_BUFFER_SIZE = 6;
const rssTimeSeries: RssSample[] = [];

/** Timestamp of the last entry written to the time-series buffer (ms). */
let lastTimeSeriesMs = 0;

/** Minimum gap between time-series entries (60 seconds). */
const TIME_SERIES_MIN_GAP_MS = 60_000;

/** Timestamp of the last soft-cap warning emission (ms). Rate-limited to 60 s. */
let lastCapWarningMs = 0;

/** Minimum gap between successive soft-cap warnings (60 seconds). */
const CAP_WARNING_COOLDOWN_MS = 60_000;

// ── private helpers ───────────────────────────────────────────────────────────

export function isMemoryTrackingEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_MEMORY_ENV];
  if (value === '0' || value === 'false' || value === 'off') return false;
  return true;
}

/**
 * Fast RSS lookup — avoids allocating the full `memoryUsage()` object when
 * the runtime exposes the sub-helper. Node 16.0+ ships it on macOS / Linux
 * / Windows; the fallback is still correct, just slightly less cheap.
 */
function readRssBytes(): number {
  const fast = (
    process.memoryUsage as typeof process.memoryUsage & { rss?: () => number }
  ).rss;
  if (typeof fast === 'function') return fast.call(process.memoryUsage);
  return process.memoryUsage().rss;
}

/**
 * Append an RSS entry to the time-series circular buffer, but only when the
 * previous entry is at least `TIME_SERIES_MIN_GAP_MS` old. The buffer is
 * capped at `RSS_BUFFER_SIZE` — the oldest entry is evicted when full.
 */
function maybeRecordTimeSeries(rssBytes: number, nowMs: number): void {
  if (rssTimeSeries.length > 0 && nowMs - lastTimeSeriesMs < TIME_SERIES_MIN_GAP_MS) {
    return;
  }
  if (rssTimeSeries.length >= RSS_BUFFER_SIZE) {
    rssTimeSeries.shift();
  }
  rssTimeSeries.push({ rssBytes, timestampMs: nowMs });
  lastTimeSeriesMs = nowMs;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Record one RSS sample against the peak tracker. Safe to call from any
 * hot path — constant-time work, never throws. The caller does not need
 * to check the env var first; that gate is applied here.
 *
 * Also:
 *   - Appends to the time-series buffer when ≥ 60 s have elapsed since the
 *     last entry (used by `getRssGrowthPerHour()`).
 *   - Emits a rate-limited `console.error` warning if the RSS exceeds the
 *     soft cap set via `OPENSAFARI_MEMORY_SOFT_CAP_MB`.
 */
export function recordMemorySample(): void {
  if (!isMemoryTrackingEnabled()) return;
  try {
    const rss = readRssBytes();
    const nowMs = Date.now();
    if (rss > peakRssBytes) peakRssBytes = rss;
    sampleCount += 1;

    maybeRecordTimeSeries(rss, nowMs);

    // Soft-cap watchdog — rate-limited to one warning per 60 s.
    const capMB = getMemorySoftCapMB();
    if (capMB !== null) {
      const rssMB = bytesToMB(rss);
      if (rssMB > capMB && nowMs - lastCapWarningMs >= CAP_WARNING_COOLDOWN_MS) {
        lastCapWarningMs = nowMs;
        console.error(
          `[memory-watchdog] RSS crossed soft cap: ${rssMB} MB > ${capMB} MB`,
        );
      }
    }
  } catch {
    // Memory sampling must never mask an input-backend failure.
  }
}

/**
 * Return the full memory snapshot. Invokes the complete
 * `process.memoryUsage()` (slower but precise) so `diagnose` callers see
 * accurate `heapUsed` / `external` numbers regardless of whether the
 * per-op sampler has been ticking.
 */
export function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  // The hot-path sampler tracks peak RSS only; `diagnose` should see the
  // peak inclusive of the current sample so it never undercuts what the
  // caller just observed.
  if (usage.rss > peakRssBytes) peakRssBytes = usage.rss;
  return {
    rssBytes: usage.rss,
    peakRssBytes,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
    sampleCount,
  };
}

/**
 * Compute the RSS growth rate in MB/hour from the time-series circular
 * buffer. Returns `null` when fewer than 2 entries have been recorded.
 *
 * The formula extrapolates linearly from the oldest to the newest entry:
 *   growth = (newest.rss − oldest.rss) / (newest.time − oldest.time) × 3600000
 */
export function getRssGrowthPerHour(): number | null {
  if (rssTimeSeries.length < 2) return null;
  const oldest = rssTimeSeries[0];
  const newest = rssTimeSeries[rssTimeSeries.length - 1];
  const deltaMs = newest.timestampMs - oldest.timestampMs;
  if (deltaMs <= 0) return null;
  const deltaBytes = newest.rssBytes - oldest.rssBytes;
  return bytesToMB(deltaBytes) / deltaMs * 3_600_000;
}

/**
 * Parse `OPENSAFARI_MEMORY_SOFT_CAP_MB` from the environment.
 * Returns the cap in MB, or `null` if the env var is unset or invalid.
 */
export function getMemorySoftCapMB(): number | null {
  const raw = process.env[OPENSAFARI_MEMORY_SOFT_CAP_MB_ENV];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Returns `true` if the current process RSS exceeds the configured soft cap.
 * Always returns `false` when the env var is unset.
 */
export function isMemoryCapExceeded(): boolean {
  const capMB = getMemorySoftCapMB();
  if (capMB === null) return false;
  return bytesToMB(readRssBytes()) > capMB;
}

/**
 * Reset the peak tracker. Intended for tests that want isolated windows
 * and for long-running daemons that want to measure growth within a
 * known period (e.g., the per-session soak test in a follow-up PR).
 *
 * Also clears the time-series buffer and soft-cap warning state so tests
 * get a fully isolated view of the tracker.
 */
export function resetMemoryTracker(): void {
  peakRssBytes = 0;
  sampleCount = 0;
  rssTimeSeries.length = 0;
  lastTimeSeriesMs = 0;
  lastCapWarningMs = 0;
}

/**
 * Convert a byte count to megabytes with two decimal places. Shared helper
 * so the MCP surface (`diagnose.memory.rss_mb` etc.) uses one definition of
 * "MB" — 1 MB == 1_048_576 B, matching `process.memoryUsage` docs.
 */
export function bytesToMB(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 100) / 100;
}
