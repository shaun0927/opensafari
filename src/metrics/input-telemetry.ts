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
import { recordMemorySample } from './memory-tracker';

/**
 * Stable set of operations we time. Matches the `InputBackend` interface
 * verbs so a consumer can partition metrics by user-visible action type.
 */
export type InputOperation = 'tap' | 'swipe' | 'typeText' | 'keypress' | 'sendKey';

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
 * Env var that opts MCP tool responses into the Phase-2 `_telemetry` metadata
 * field. When set to `1` / `true`, each input tool (`app_tap`, `app_swipe`,
 * ...) attaches the captured `InputTelemetryEvent` list under `_meta._telemetry`
 * so clients and CI can assert on `elapsed_ms` without scraping stderr.
 *
 * Default-off so the field is strictly opt-in and does not inflate payloads
 * for consumers that only care about success/failure.
 */
export const OPENSAFARI_INPUT_TELEMETRY_META_ENV = 'OPENSAFARI_INPUT_TELEMETRY_META';

function isTelemetryEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
  return value !== '0' && value !== 'false';
}

/** Whether input tool responses should include `_meta._telemetry`. */
export function isInputTelemetryMetaEnabled(): boolean {
  const value = process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV];
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
  // Piggyback a cheap RSS sample on every telemetry tick so peak memory
  // is observable from `diagnose` without any separate scheduling. The
  // tracker guards itself with its own env var and try/catch, so this
  // call cannot destabilise the telemetry path.
  recordMemorySample();
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
    });
    throw err;
  }
}
