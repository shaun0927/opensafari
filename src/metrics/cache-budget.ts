/**
 * Cache-budget survey — step 5 item 3 of issue #554's memory SLO plan.
 *
 * `docs/memory-budget.md` publishes a per-cache retention budget for every
 * module-level `Map` / `Set` in `src/`. This module walks a hand-picked
 * subset of those caches at runtime, estimates each one's byte footprint,
 * and emits a structured note for any cache that has outgrown its budget.
 * The resulting notes are surfaced through `diagnose.memory.notes` so the
 * MCP client gets actionable "which cache is leaking" feedback without
 * needing a heap snapshot.
 *
 * The survey is deliberately conservative:
 *   - Only read-only accessors are called (all side-effect-free).
 *   - Each accessor is wrapped in try/catch so one misbehaving cache never
 *     destabilises `diagnose`.
 *   - Byte estimates are heuristics, not heap-snapshot accurate — they are
 *     intended to catch order-of-magnitude budget regressions, not to replace
 *     a proper leak profiler.
 *
 * Extending: add an entry to `CACHES` for each new module-level cache. The
 * `docs/memory-budget.md` table row is the source of truth for `maxBytes`;
 * keep the two in sync when bumping a cap.
 */

import {
  getInputTelemetryRollupSampleCount,
  getInputTelemetryRollupBucketCount,
  INPUT_TELEMETRY_ROLLUP_CAP,
} from './input-telemetry-rollup';
import { getFlutterVMClientCount } from '../flutter/vm-service-client';
import { getFlutterClientCacheSize } from '../tools/native-input-backend';

/**
 * One row in the cache-budget survey. Mirrors a single row of the table in
 * `docs/memory-budget.md` plus a runtime byte-size estimator.
 */
export interface CacheBudgetEntry {
  /** Short, diagnose-friendly name. Shown in `notes` when over budget. */
  name: string;
  /** Upper bound in bytes from `docs/memory-budget.md`. */
  maxBytes: number;
  /** Best-effort estimate of current retained bytes. Never throws. */
  estimateBytes: () => number;
}

/** One note per over-budget cache, returned by `getCacheBudgetNotes`. */
export interface CacheBudgetReport {
  name: string;
  currentBytes: number;
  maxBytes: number;
}

// ── byte-size heuristics ─────────────────────────────────────────────────────
// Numbers are intentionally pessimistic (err on the larger side) so the
// survey catches regressions early rather than waiting for an OOM.

/** Rough heap cost of one latency sample: Number slot + ring-buffer overhead. */
const BYTES_PER_ROLLUP_SAMPLE = 16;
/** Fixed overhead per `${backendKind}:${operation}` bucket (arrays + counters). */
const BYTES_PER_ROLLUP_BUCKET = 256;

/** Pessimistic per-entry cost for a cached `FlutterVMClient` (WebSocket + ISOs). */
const BYTES_PER_FLUTTER_VM_CLIENT = 2 * 1_048_576; // 2 MB — matches doc row
/** Pessimistic per-entry cost for the Flutter discovery cache (client ref or nil). */
const BYTES_PER_FLUTTER_DISCOVERY_ENTRY = 64 * 1024; // 64 KB

/**
 * Caches surveyed by `getCacheBudgetNotes()`. The order here mirrors the
 * table order in `docs/memory-budget.md` for easy cross-referencing.
 *
 * This list starts with the three caches most likely to grow under real
 * agent workloads. Adding a new cache is two lines here + one table row
 * in the doc + (usually) one exported size accessor on the cache module.
 */
const CACHES: CacheBudgetEntry[] = [
  {
    name: 'telemetry-rollup',
    maxBytes: 1 * 1_048_576, // 1 MB per doc
    estimateBytes: () => {
      const samples = getInputTelemetryRollupSampleCount();
      const buckets = getInputTelemetryRollupBucketCount();
      return samples * BYTES_PER_ROLLUP_SAMPLE + buckets * BYTES_PER_ROLLUP_BUCKET;
    },
  },
  {
    name: 'flutter-vm-clients',
    // Doc row: 2 MB / entry. Derive a total budget from the same ring-buffer
    // cap the rollup uses — this is intentionally generous so we only alert
    // on genuinely unbounded growth.
    maxBytes: INPUT_TELEMETRY_ROLLUP_CAP * BYTES_PER_FLUTTER_VM_CLIENT,
    estimateBytes: () => getFlutterVMClientCount() * BYTES_PER_FLUTTER_VM_CLIENT,
  },
  {
    name: 'flutter-discovery-cache',
    maxBytes: 64 * 1024 * 64, // 64 entries * 64 KB ≈ 4 MB hard cap
    estimateBytes: () =>
      getFlutterClientCacheSize() * BYTES_PER_FLUTTER_DISCOVERY_ENTRY,
  },
];

// ── public API ───────────────────────────────────────────────────────────────

/** Format bytes in a compact, human-readable unit for `diagnose.notes`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1_073_741_824) {
    return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;
  }
  return `${(bytes / 1_073_741_824).toFixed(1).replace(/\.0$/, '')} GB`;
}

/** Structured report for every cache currently exceeding its budget. */
export function getCacheBudgetReports(): CacheBudgetReport[] {
  const reports: CacheBudgetReport[] = [];
  for (const c of CACHES) {
    try {
      const current = c.estimateBytes();
      if (Number.isFinite(current) && current > c.maxBytes) {
        reports.push({
          name: c.name,
          currentBytes: current,
          maxBytes: c.maxBytes,
        });
      }
    } catch {
      // One bad accessor must not destabilise the survey.
    }
  }
  return reports;
}

/**
 * Human-readable notes for `diagnose.memory.notes`. Returns `[]` when every
 * surveyed cache is within budget. Matches the example shape from issue #554:
 *   `"telemetry-rollup: 340 KB"` / `"flutter-vm-clients: 2.1 MB"`.
 */
export function getCacheBudgetNotes(): string[] {
  return getCacheBudgetReports().map(
    (r) =>
      `${r.name}: ${formatBytes(r.currentBytes)} (over budget ${formatBytes(r.maxBytes)})`,
  );
}

/** Test hook: iterate the surveyed cache registry (read-only). */
export function __listBudgetedCaches(): ReadonlyArray<Readonly<CacheBudgetEntry>> {
  return CACHES;
}
