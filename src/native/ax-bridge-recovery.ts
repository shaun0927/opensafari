/**
 * ax-bridge self-healing wrapper (issue #643).
 *
 * The Swift accessibility bridge occasionally fails mid-session with
 * transient errors (`DEVICE_CONTENT_ROOT_EMPTY`, `AX_TIMEOUT`,
 * `BRIDGE_EXEC_FAILED`, or a generic `AX_ERROR` payload). Without retry
 * logic a single failure poisons the whole verification lane because the
 * next call inherits the bad tree state.
 *
 * `dumpTreeWithRecovery` wraps `AccessibilityBridge.dumpTree()` with a
 * classified retry loop:
 *
 *   1. Attempt a dump.
 *   2. On a recoverable error, sleep `backoffMs[i]` then (optionally) run
 *      `ensureSemanticsActive({ forceRefresh: true })` to force Flutter /
 *      simulator chrome to rematerialise its tree.
 *   3. Retry up to `maxAttempts` times.
 *
 * Non-recoverable errors (`BRIDGE_NOT_FOUND`, `AX_PERMISSION_DENIED`)
 * short-circuit immediately; no amount of retrying fixes a missing binary
 * or a denied TCC prompt.
 *
 * Every call returns an `AxBridgeRecoveryReport` (even the happy path with
 * a single successful dump) so callers can expose the data via their
 * `meta.axBridgeRecovery` diagnostics field without conditional branching.
 */

import {
  AccessibilityBridge,
  AccessibilityBridgeError,
} from './accessibility-bridge';
import { ensureSemanticsActive } from './semantics-activator';
import type { AXDumpOptions, AXNode } from './ax-types';

/** Error codes that represent transient, retry-worthy failures. */
export const RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEVICE_CONTENT_ROOT_EMPTY',
  'AX_TIMEOUT',
  'BRIDGE_EXEC_FAILED',
  'AX_ERROR',
]);

/** Error codes that must be surfaced immediately without retrying. */
export const NON_RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'BRIDGE_NOT_FOUND',
  'AX_PERMISSION_DENIED',
]);

/** Typed final error when a Flutter target never rematerialises native semantics. */
export const FLUTTER_SEMANTICS_INACTIVE = 'FLUTTER_SEMANTICS_INACTIVE';

/** Default backoff schedule used between retries (ms). */
export const DEFAULT_BACKOFF_MS: readonly number[] = [200, 500, 1200];
/** Default retry budget. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Budget granted to the between-attempt `ensureSemanticsActive` call. */
export const DEFAULT_REACTIVATE_TIMEOUT_MS = 2500;

export interface AxBridgeRecoveryStage {
  /** 1-indexed attempt number associated with this stage. */
  attempt: number;
  action: 'dump' | 'reactivate' | 'sleep';
  /** `Date.now()` when the stage began. */
  startedAt: number;
  durationMs: number;
  outcome: 'ok' | 'error';
  /** `AccessibilityBridgeError.code` when outcome is `error`. */
  errorCode?: string;
}

export interface AxBridgeRecoveryReport {
  /** Number of `dumpTree()` attempts actually performed. */
  attempts: number;
  /** Whether the final dump succeeded. */
  recovered: boolean;
  /** Chronological log of every action taken. */
  stages: AxBridgeRecoveryStage[];
  /** Error code from the final failure (only when `recovered === false`). */
  lastErrorCode?: string;
}

export interface DumpTreeWithRecoveryOptions extends AXDumpOptions {
  /** Forwarded to `ensureSemanticsActive` during inter-attempt reactivation. */
  bundleId?: string;
  /** Max number of `dumpTree` invocations. Default 3. Min 1. */
  maxAttempts?: number;
  /**
   * Inter-attempt sleep schedule. Entry `i` is the pause between attempt
   * `i+1` and attempt `i+2`. If fewer entries are provided than
   * `maxAttempts - 1`, the last entry is reused. Default `[200, 500, 1200]`.
   */
  backoffMs?: number[];
  /** Re-run `ensureSemanticsActive({ forceRefresh: true })` before each retry. Default true. */
  reactivateOnRetry?: boolean;
  /**
   * Injection seam for tests — swap the real activator with a deterministic
   * stub. Defaults to the production `ensureSemanticsActive`.
   */
  reactivate?: (
    deviceId: string,
    opts: { forceRefresh: true; timeout: number; bundleId?: string },
  ) => Promise<boolean>;
  /** Injection seam for tests — swap the default `setTimeout` sleeper. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DumpTreeWithRecoveryResult {
  tree: AXNode;
  recovery: AxBridgeRecoveryReport;
}

function isRecoverableError(err: unknown): err is AccessibilityBridgeError {
  if (!(err instanceof AccessibilityBridgeError)) return false;
  if (NON_RECOVERABLE_ERROR_CODES.has(err.code)) return false;
  return RECOVERABLE_ERROR_CODES.has(err.code);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBackoff(
  schedule: readonly number[] | undefined,
  gapIndex: number,
): number {
  const source = schedule && schedule.length > 0 ? schedule : DEFAULT_BACKOFF_MS;
  return source[Math.min(gapIndex, source.length - 1)] ?? 0;
}

function shouldPromoteFlutterSemanticsInactive(
  err: AccessibilityBridgeError,
  options: DumpTreeWithRecoveryOptions,
  stages: readonly AxBridgeRecoveryStage[],
): boolean {
  return Boolean(options.bundleId) &&
    err.code === 'DEVICE_CONTENT_ROOT_EMPTY' &&
    stages.some((stage) =>
      stage.action === 'reactivate' &&
      stage.outcome === 'error' &&
      stage.errorCode === 'REACTIVATE_RETURNED_FALSE',
    );
}

function promoteFlutterSemanticsInactive(
  err: AccessibilityBridgeError,
  options: DumpTreeWithRecoveryOptions,
): AccessibilityBridgeError {
  return new AccessibilityBridgeError(
    `Flutter semantics remained inactive for bundle ${options.bundleId} after ax-bridge recovery; ` +
      `the native accessibility tree stayed empty after simulator reactivation. Original error: ${err.message}`,
    FLUTTER_SEMANTICS_INACTIVE,
  );
}

/**
 * Dump the accessibility tree with bounded retry + optional reactivation.
 *
 * @throws the last `AccessibilityBridgeError` when the retry budget is
 *   exhausted or a non-recoverable error is observed. Inspect the thrown
 *   error's `.recovery` property (attached by this wrapper) for stage-level
 *   diagnostics when you need to surface them alongside the error itself.
 */
export async function dumpTreeWithRecovery(
  bridge: AccessibilityBridge,
  options: DumpTreeWithRecoveryOptions,
): Promise<DumpTreeWithRecoveryResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const reactivateOnRetry = options.reactivateOnRetry ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const reactivate = options.reactivate ?? ensureSemanticsActive;

  const stages: AxBridgeRecoveryStage[] = [];
  let attempt = 0;
  let lastError: AccessibilityBridgeError | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;

    const dumpStart = Date.now();
    try {
      const tree = await bridge.dumpTree({
        deviceId: options.deviceId,
        maxDepth: options.maxDepth,
      });
      stages.push({
        attempt,
        action: 'dump',
        startedAt: dumpStart,
        durationMs: Date.now() - dumpStart,
        outcome: 'ok',
      });
      return {
        tree,
        recovery: { attempts: attempt, recovered: true, stages },
      };
    } catch (err) {
      const durationMs = Date.now() - dumpStart;
      const code = err instanceof AccessibilityBridgeError ? err.code : 'UNKNOWN';
      stages.push({
        attempt,
        action: 'dump',
        startedAt: dumpStart,
        durationMs,
        outcome: 'error',
        errorCode: code,
      });

      if (!isRecoverableError(err)) {
        const wrapped = err instanceof AccessibilityBridgeError
          ? err
          : new AccessibilityBridgeError(
            err instanceof Error ? err.message : String(err),
            'UNKNOWN',
          );
        attachRecoveryReport(wrapped, {
          attempts: attempt,
          recovered: false,
          stages,
          lastErrorCode: wrapped.code,
        });
        throw wrapped;
      }

      lastError = err;

      if (attempt >= maxAttempts) break;

      const backoff = resolveBackoff(options.backoffMs, attempt - 1);
      if (backoff > 0) {
        const sleepStart = Date.now();
        await sleep(backoff);
        stages.push({
          attempt,
          action: 'sleep',
          startedAt: sleepStart,
          durationMs: Date.now() - sleepStart,
          outcome: 'ok',
        });
      }

      if (reactivateOnRetry && options.deviceId) {
        const reactStart = Date.now();
        try {
          const reactivated = await reactivate(options.deviceId, {
            forceRefresh: true,
            timeout: DEFAULT_REACTIVATE_TIMEOUT_MS,
            bundleId: options.bundleId,
          });
          // `ensureSemanticsActive` resolves to `false` when activation times
          // out or fails without throwing — surface that as an error stage so
          // downstream telemetry does not mistake silent failure for success.
          stages.push({
            attempt,
            action: 'reactivate',
            startedAt: reactStart,
            durationMs: Date.now() - reactStart,
            outcome: reactivated ? 'ok' : 'error',
            ...(reactivated ? {} : { errorCode: 'REACTIVATE_RETURNED_FALSE' }),
          });
        } catch (reactErr) {
          stages.push({
            attempt,
            action: 'reactivate',
            startedAt: reactStart,
            durationMs: Date.now() - reactStart,
            outcome: 'error',
            errorCode: reactErr instanceof AccessibilityBridgeError
              ? reactErr.code
              : 'REACTIVATE_FAILED',
          });
          // Reactivation is best-effort — keep retrying the dump regardless.
        }
      }
    }
  }

  const finalError = lastError ?? new AccessibilityBridgeError(
    'ax-bridge dump failed with no recoverable error recorded',
    'UNKNOWN',
  );
  const surfacedError = shouldPromoteFlutterSemanticsInactive(finalError, options, stages)
    ? promoteFlutterSemanticsInactive(finalError, options)
    : finalError;
  attachRecoveryReport(surfacedError, {
    attempts: attempt,
    recovered: false,
    stages,
    lastErrorCode: surfacedError.code,
  });
  throw surfacedError;
}

/** Extend the thrown error with the diagnostics report without breaking existing `catch` blocks. */
function attachRecoveryReport(
  err: AccessibilityBridgeError,
  report: AxBridgeRecoveryReport,
): void {
  (err as AccessibilityBridgeError & { recovery?: AxBridgeRecoveryReport }).recovery = report;
}
