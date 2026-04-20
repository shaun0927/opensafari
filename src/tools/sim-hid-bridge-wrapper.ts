/**
 * Pure helpers for `cli/sim-hid-bridge.ts`.
 *
 * The wrapper's transitional-state detection is exported here as a pure
 * function so it can be unit-tested without spawning the native bridge.
 * See GitHub issue #46.
 */

export interface WrapperProbeFlags {
  expectBundle?: string;
  requireMatch?: boolean;
  settleMs?: number;
  maxSettleRetries?: number;
}

export interface ProbeRunningApp {
  bundleId: string;
  pid?: number;
}

export interface ProbeResult {
  classification?: string;
  verified?: boolean;
  contextVerified?: boolean;
  runningApps?: ProbeRunningApp[];
  warnings?: string[];
  [key: string]: unknown;
}

export const DEFAULT_SETTLE_MS = 1200;
export const DEFAULT_MAX_SETTLE_RETRIES = 1;
export const MAX_ALLOWED_SETTLE_RETRIES = 3;

/**
 * Clamp a user-supplied `--max-settle-retries` value to the supported range
 * {0, 1, 2, 3}. Non-integers, NaN, and out-of-range values collapse to the
 * default (1).
 */
export function normalizeMaxSettleRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_SETTLE_RETRIES;
  }
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  if (floored > MAX_ALLOWED_SETTLE_RETRIES) return MAX_ALLOWED_SETTLE_RETRIES;
  return floored;
}

export function effectiveSettleMs(flags: WrapperProbeFlags): number {
  return flags.settleMs && flags.settleMs > 0 ? flags.settleMs : DEFAULT_SETTLE_MS;
}

function expectedBundleInRunningApps(
  expectBundle: string,
  runningApps: ProbeRunningApp[] | undefined,
): boolean {
  if (!runningApps || runningApps.length === 0) return false;
  return runningApps.some((app) => app?.bundleId === expectBundle);
}

/**
 * Apply the issue #46 Option-A detection rule to the result of a first
 * `probeContext` call. Performs at most one re-probe (via `reprobe`) and
 * promotes to `TRANSITIONAL_STATE_TIMEOUT` when both probes return
 * `FOREGROUND_CONTEXT_UNAVAILABLE` while the expected bundle is running.
 *
 * Pure — all I/O is delegated to the caller-provided `reprobe`.
 */
export async function applyTransitionalPromotion(
  firstResult: ProbeResult,
  flags: WrapperProbeFlags,
  reprobe: () => Promise<ProbeResult>,
): Promise<ProbeResult> {
  const maxRetries = normalizeMaxSettleRetries(flags.maxSettleRetries ?? DEFAULT_MAX_SETTLE_RETRIES);
  if (maxRetries < 1) return firstResult;
  if (firstResult.classification !== 'FOREGROUND_CONTEXT_UNAVAILABLE') return firstResult;
  if (!flags.expectBundle) return firstResult;
  if (!expectedBundleInRunningApps(flags.expectBundle, firstResult.runningApps)) {
    return firstResult;
  }

  const secondResult = await reprobe();
  if (secondResult.classification !== 'FOREGROUND_CONTEXT_UNAVAILABLE') {
    return secondResult;
  }

  const totalMs = 2 * effectiveSettleMs(flags);
  const existingWarnings = Array.isArray(secondResult.warnings) ? secondResult.warnings : [];
  return {
    ...secondResult,
    classification: 'TRANSITIONAL_STATE_TIMEOUT',
    verified: false,
    warnings: [
      ...existingWarnings,
      `Foreground AX tree remained empty for ${totalMs}ms while ${flags.expectBundle} is running — treated as a transitional timeout.`,
    ],
  };
}
