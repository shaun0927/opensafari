/**
 * Input backend latency telemetry — Phase 1 of Epic #484 reliability ACs.
 *
 * Wraps every `InputBackend` operation so we can emit per-operation timing
 * (`elapsed_ms`) for the downstream p50/p95/p99 rollups. The sink is
 * intentionally minimal: a single structured `console.error` line per event
 * tagged `[input-telemetry]`. That keeps the stream grep/jq-friendly and
 * leaves room for Phase 2 (attaching metadata to MCP tool responses) and
 * Phase 3 (OpenTelemetry / Prometheus exporters) without a rewrite.
 *
 * See issue #502 for the rollout checklist.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { InputBackendKind } from '../tools/native-input-backend';
import { accumulateInputTelemetry } from './input-telemetry-rollup';
import {
  recordMemorySample,
  recordMemorySampleFromRss,
  bytesToMB,
  isMemoryTrackingEnabled,
} from './memory-tracker';

/**
 * Stable set of operations we time. Matches the `InputBackend` interface
 * verbs so a consumer can partition metrics by user-visible action type.
 */
export type InputOperation = 'tap' | 'swipe' | 'typeText' | 'keypress' | 'sendKey' | 'keyChord';

/**
 * One telemetry event. Keys are deliberately snake_case so downstream
 * Prometheus / OpenTelemetry wiring can map labels 1:1 without renames.
 */
export interface InputTelemetryEvent {
  backendKind: InputBackendKind;
  operation: InputOperation;
  deviceId: string;
  elapsed_ms: number;
  ok: boolean;
  /** Present only when `ok === false`. */
  error?: string;
  /**
   * Resident set size in MB at the time the event was emitted.
   * Only present when `OPENSAFARI_INPUT_TELEMETRY_MEMORY` is not disabled.
   */
  rss_mb?: number;
  /**
   * V8 heap used in MB at the time the event was emitted.
   * Only present when `OPENSAFARI_INPUT_TELEMETRY_MEMORY` is not disabled.
   */
  heap_used_mb?: number;
}

/** Alias retained for the shape referenced in the proposal in #502. */
export type InputOperationResult = InputTelemetryEvent;

/**
 * Env var that disables the console sink. Set `OPENSAFARI_INPUT_TELEMETRY=0`
 * (or `false`) to silence emission without touching source. Any other value
 * — including unset — leaves telemetry on.
 */
export const OPENSAFARI_INPUT_TELEMETRY_ENV = 'OPENSAFARI_INPUT_TELEMETRY';

/**
 * Env var that controls the Phase-2 `_telemetry` metadata field on MCP tool
 * responses. Each input tool (`app_tap`, `app_swipe`, ...) attaches the
 * captured `InputTelemetryEvent` list under `_meta._telemetry` so clients and
 * CI can assert on `elapsed_ms` without scraping stderr.
 *
 * Default-on since 0.5.0 (issue #595). Set to `0` / `false` to opt out and
 * suppress the `_telemetry` projection when payload size matters.
 */
export const OPENSAFARI_INPUT_TELEMETRY_META_ENV = 'OPENSAFARI_INPUT_TELEMETRY_META';

/**
 * Env var that opts `_meta` responses into including a `memory` snapshot
 * (rss_mb + heap_used_mb). Set to `1` / `true` to enable.
 * Default-off so memory fields don't inflate payloads for consumers that
 * don't need them.
 */
export const OPENSAFARI_TELEMETRY_INCLUDE_MEMORY = 'OPENSAFARI_TELEMETRY_INCLUDE_MEMORY';

function isTelemetryEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
  return value !== '0' && value !== 'false';
}

/** Whether input tool responses should include `_meta._telemetry`. */
export function isInputTelemetryMetaEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV];
  return value !== '0' && value !== 'false';
}

/**
 * Whether `_meta` responses should include a `memory` snapshot.
 * Controlled by `OPENSAFARI_TELEMETRY_INCLUDE_MEMORY=1` / `true`.
 */
export function isMemoryMetaEnabled(): boolean {
  const value = process.env[OPENSAFARI_TELEMETRY_INCLUDE_MEMORY];
  return value === '1' || value === 'true';
}

type TelemetrySink = (event: InputTelemetryEvent) => void;

function consoleSink(event: InputTelemetryEvent): void {
  if (!isTelemetryEnabled()) return;
  console.error(`[input-telemetry] ${JSON.stringify(event)}`);
}

let activeSink: TelemetrySink = consoleSink;

/**
 * Per-async-context capture store. When a caller opens a scope via
 * `captureInputTelemetry`, every event emitted inside that scope — and only
 * that scope — is appended to the bound array. Isolation is handled by
 * `AsyncLocalStorage`, so concurrent MCP tool calls do not cross-contaminate.
 */
const captureStore = new AsyncLocalStorage<InputTelemetryEvent[]>();

/** Emit a telemetry event through the active sink. Never throws. */
export function emitInputTelemetry(event: InputTelemetryEvent): void {
  try {
    activeSink(event);
  } catch {
    // The telemetry path must never mask an input-backend failure.
  }
  try {
    accumulateInputTelemetry(event);
  } catch {
    // Ditto — rollup failures stay invisible to the caller.
  }
  // Piggyback peak-RSS tracking on every telemetry tick so `diagnose`
  // observes memory without any separate scheduling. When the caller
  // already sampled a full `process.memoryUsage()` (e.g. `timedInput`
  // via `sampleMemoryFields`) we reuse its RSS reading to avoid a
  // redundant syscall on the per-op hot path (#554 microbench budget).
  if (event.rss_mb !== undefined) {
    recordMemorySampleFromRss(event.rss_mb * 1_048_576);
  } else {
    recordMemorySample();
  }
  const buf = captureStore.getStore();
  if (buf) buf.push(event);
}

/**
 * Run `fn` inside a telemetry capture scope. Every `timedInput` event fired
 * by `fn` (directly or via any awaited descendant) is collected and returned
 * alongside `fn`'s result. The sink still fires as usual — capture is a
 * read-only subscriber, not a redirect.
 */
export async function captureInputTelemetry<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; events: InputTelemetryEvent[] }> {
  const events: InputTelemetryEvent[] = [];
  const result = await captureStore.run(events, fn);
  return { result, events };
}

/**
 * Override the telemetry sink. Intended for unit tests that want to assert
 * on the emitted events without parsing stderr. Pass `null` to restore the
 * default `console.error` sink.
 */
export function __setInputTelemetrySinkForTest(sink: TelemetrySink | null): void {
  activeSink = sink ?? consoleSink;
}

/**
 * Millisecond-precision elapsed time. Uses `process.hrtime.bigint()` when
 * available (Node) and falls back to `Date.now()` so the helper is safe to
 * import from environments that only provide the Web timing API.
 */
function nowNs(): bigint {
  if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
    return process.hrtime.bigint();
  }
  return BigInt(Date.now()) * 1_000_000n;
}

function elapsedMs(startNs: bigint): number {
  const deltaNs = nowNs() - startNs;
  // Round to the nearest integer millisecond. Negative deltas are impossible
  // with hrtime but we clamp to 0 defensively for the Date.now() fallback.
  const ms = Number(deltaNs) / 1e6;
  return Math.max(0, Math.round(ms));
}

/**
 * Wrap an `InputBackend` operation so every call emits a structured timing
 * event on completion (success and failure alike).
 *
 * Callers keep their signatures unchanged — `timedInput` simply threads the
 * returned promise through. On rejection it emits an `ok: false` event with
 * the error message attached and re-throws so routing/error handling stay
 * authoritative.
 */
/**
 * Sample rss_mb and heap_used_mb from `process.memoryUsage()` when memory
 * tracking is enabled. Returns an object with both fields, or an empty object
 * when sampling is disabled or fails.
 */
function sampleMemoryFields(): { rss_mb?: number; heap_used_mb?: number } {
  if (!isMemoryTrackingEnabled()) return {};
  try {
    const usage = process.memoryUsage();
    return {
      rss_mb: bytesToMB(usage.rss),
      heap_used_mb: bytesToMB(usage.heapUsed),
    };
  } catch {
    return {};
  }
}

export async function timedInput<T>(
  backendKind: InputBackendKind,
  operation: InputOperation,
  deviceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = nowNs();
  try {
    const result = await fn();
    emitInputTelemetry({
      backendKind,
      operation,
      deviceId,
      elapsed_ms: elapsedMs(start),
      ok: true,
      ...sampleMemoryFields(),
    });
    return result;
  } catch (err) {
    emitInputTelemetry({
      backendKind,
      operation,
      deviceId,
      elapsed_ms: elapsedMs(start),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...sampleMemoryFields(),
    });
    throw err;
  }
}
