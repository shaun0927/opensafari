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
 * A follow-up issue will add:
 *   - Per-backend rollup (avg / p95 / max RSS delta per op)
 *   - Soak-test hook that asserts growth-rate SLOs
 *   - Optional `OPENSAFARI_MEMORY_SOFT_CAP_MB` watchdog + `diagnose` warning
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
   * assert that `recordSample()` is actually being called from the
   * telemetry path.
   */
  sampleCount: number;
}

let peakRssBytes = 0;
let sampleCount = 0;

function isMemoryTrackingEnabled(): boolean {
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
 * Record one RSS sample against the peak tracker. Safe to call from any
 * hot path — constant-time work, never throws. The caller does not need
 * to check the env var first; that gate is applied here.
 */
export function recordMemorySample(): void {
  if (!isMemoryTrackingEnabled()) return;
  try {
    const rss = readRssBytes();
    if (rss > peakRssBytes) peakRssBytes = rss;
    sampleCount += 1;
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
 * Reset the peak tracker. Intended for tests that want isolated windows
 * and for long-running daemons that want to measure growth within a
 * known period (e.g., the per-session soak test in a follow-up PR).
 */
export function resetMemoryTracker(): void {
  peakRssBytes = 0;
  sampleCount = 0;
}

/**
 * Convert a byte count to megabytes with two decimal places. Shared helper
 * so the MCP surface (`diagnose.memory.rss_mb` etc.) uses one definition of
 * "MB" — 1 MB == 1_048_576 B, matching `process.memoryUsage` docs.
 */
export function bytesToMB(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 100) / 100;
}
