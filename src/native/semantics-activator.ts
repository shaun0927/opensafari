/**
 * Flutter Semantics Activator
 *
 * Flutter lazily builds its accessibility/semantics tree — it only populates
 * native UIAccessibilityElement objects when an assistive technology (e.g.
 * VoiceOver) is detected. This module forces semantics activation so that
 * `app_tree`, `app_query`, and `app_inspect` return a populated tree for
 * Flutter apps.
 *
 * Strategy (ordered by cost and reliability):
 *   A. Negative-cache check: if a recent attempt already determined that
 *      semantics are unavailable, return immediately without re-probing.
 *   B. Quick-check: if the tree already has enough nodes, skip activation.
 *   C. Simctl activation: enable the macOS Accessibility Inspector flag via
 *      `xcrun simctl spawn defaults write`. This triggers Flutter's
 *      `SemanticsBinding` without full VoiceOver side effects.
 *   D. Dart VM Service fallback (debug/profile builds only): connect to the
 *      app's VM Service and call `debugDumpSemanticsTreeInTraversalOrder`,
 *      which forces Flutter to materialise the semantics tree even when the
 *      native accessibility flag did not propagate (e.g. when the activation
 *      flag was already set by a previous session and no rebuild fired).
 *   E. Hard timeout: throw `FlutterSemanticsUnavailableError` when the overall
 *      budget (default 5 s, env-overridable) is exceeded, and cache the
 *      negative result so the next call does not re-pay the timeout cost.
 */

import { getAccessibilityBridge } from './accessibility-bridge';
import type { AXNode } from './ax-types';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 300;
const MIN_NODE_THRESHOLD = 5;
const VM_SERVICE_DISCOVERY_TIMEOUT_MS = 3000;
const VM_SERVICE_CONNECT_TIMEOUT_MS = 3000;

/**
 * Hard ceiling on the *entire* ensureSemanticsActive call path.
 * Overridable via OPENSAFARI_SEMANTICS_ACTIVATION_TIMEOUT_MS.
 */
const HARD_TIMEOUT_MS: number = (() => {
  const envVal = process.env.OPENSAFARI_SEMANTICS_ACTIVATION_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5000;
})();

/** How long a negative-cache entry stays hot (30 s). */
const NEGATIVE_CACHE_TTL_MS = 30_000;

/**
 * Minimum spacing between fresh AX-tree probes when a cache entry is hot.
 * Without this, conditions improving mid-TTL (e.g. user re-launches via
 * `flutter run`) keep being masked by the cached failure for the full 30 s.
 * With this, cache hits trigger a quick re-probe at most once every N ms so
 * the negative cache stops poisoning the device once the tree responds again.
 */
const NEGATIVE_CACHE_RECHECK_INTERVAL_MS = 3000;

// ── Typed error ──────────────────────────────────────────────────────────────

/** Reason codes for why Flutter Semantics could not be activated. */
export type FlutterSemanticsUnavailableReason = 'no-dds' | 'timeout' | 'not-flutter';

/**
 * Thrown by `ensureSemanticsActive` when semantics cannot be activated within
 * the allowed budget. Callers should catch this to fall back to AX-only
 * queries rather than letting the hang propagate to the MCP client.
 */
export class FlutterSemanticsUnavailableError extends Error {
  readonly reason: FlutterSemanticsUnavailableReason;

  constructor(reason: FlutterSemanticsUnavailableReason, message: string) {
    super(message);
    this.name = 'FlutterSemanticsUnavailableError';
    this.reason = reason;
  }
}

// ── Negative cache ────────────────────────────────────────────────────────────

interface NegativeCacheEntry {
  reason: FlutterSemanticsUnavailableReason;
  expiresAt: number;
  /**
   * Earliest time at which the next fresh AX-tree probe is allowed.
   * Set on cache creation and bumped after each unsuccessful re-probe so
   * cache hits cannot probe more than once per `NEGATIVE_CACHE_RECHECK_INTERVAL_MS`.
   */
  nextRecheckAt: number;
}

const negativeCache = new Map<string, NegativeCacheEntry>();

/** Exposed for tests so they can clear the cache between cases. */
export function _clearNegativeCacheForTest(): void {
  negativeCache.clear();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EnsureSemanticsOptions {
  /** Total budget for the activation attempt (default 3000ms). */
  timeout?: number;
  /** Minimum node count that signals an active tree (default 5). */
  minNodes?: number;
  /** Bundle ID of the target app — helps Dart VM Service discovery. */
  bundleId?: string;
  /**
   * Enable the Dart VM Service fallback for debug/profile builds.
   * Defaults to `true`; callers can disable when they know the app is a
   * release build or when VM Service discovery is known to be unavailable.
   */
  useVMServiceFallback?: boolean;
}

/**
 * Count all nodes in an accessibility tree (recursive).
 */
export function countNodes(node: AXNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

/**
 * Attempt to activate Flutter semantics for a given simulator device.
 *
 * On success, returns `true`.
 *
 * On failure (timeout, no DDS, not a Flutter app), throws
 * `FlutterSemanticsUnavailableError` and caches the negative result for
 * `NEGATIVE_CACHE_TTL_MS` milliseconds so subsequent calls return
 * immediately without re-probing.
 *
 * This is a no-op for native (non-Flutter) apps that already expose a full
 * accessibility tree (quick-check A passes immediately).
 */
export async function ensureSemanticsActive(
  deviceId: string,
  options?: EnsureSemanticsOptions,
): Promise<boolean> {
  // A. Negative-cache hit — re-probe AX tree before honoring the cache so
  //    transient failures cannot poison the device for the full TTL once
  //    conditions improve (e.g. user re-launches via `flutter run`). The
  //    re-probe is rate-limited to at most once per
  //    NEGATIVE_CACHE_RECHECK_INTERVAL_MS so we don't pay the probe cost on
  //    every call for genuinely-failing devices.
  const now = Date.now();
  const cached = negativeCache.get(deviceId);
  if (cached && cached.expiresAt > now) {
    if (now < cached.nextRecheckAt) {
      // Inside the back-off window — honor the cache without probing.
      throw new FlutterSemanticsUnavailableError(
        cached.reason,
        `Flutter Semantics unavailable (cached reason: ${cached.reason}) — will retry after cache expires`,
      );
    }

    // Back-off elapsed — try a single fresh AX-tree probe before honoring.
    const probeBridge = getAccessibilityBridge();
    const probeMinNodes = options?.minNodes ?? MIN_NODE_THRESHOLD;
    if (await treeIsPopulated(probeBridge, deviceId, probeMinNodes)) {
      // Conditions improved — evict the stale cache and proceed normally.
      // The downstream quick-check (step B in `_runActivation`) will hit the
      // populated tree and return success without re-paying activation cost.
      negativeCache.delete(deviceId);
    } else {
      // Still failing — extend the back-off so subsequent calls within the
      // next interval honor the cache without probing again.
      cached.nextRecheckAt = now + NEGATIVE_CACHE_RECHECK_INTERVAL_MS;
      throw new FlutterSemanticsUnavailableError(
        cached.reason,
        `Flutter Semantics unavailable (cached reason: ${cached.reason}) — will retry after cache expires`,
      );
    }
  }

  // Race the full activation attempt against the hard timeout.
  const hardDeadline = now + HARD_TIMEOUT_MS;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const hardTimeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new FlutterSemanticsUnavailableError(
        'timeout',
        `Flutter Semantics activation timed out after ${HARD_TIMEOUT_MS} ms — ` +
          'the app may have been launched via `xcrun simctl launch` (no DDS) or is a release build. ' +
          'Use `flutter run` for full Semantics support.',
      ));
    }, HARD_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      _runActivation(deviceId, options, hardDeadline),
      hardTimeoutPromise,
    ]);
    return result;
  } catch (err) {
    if (err instanceof FlutterSemanticsUnavailableError) {
      // Cache the negative result. Defer the first re-probe by the back-off
      // interval so callers that hammer ensureSemanticsActive immediately
      // after a failure don't pay the probe cost repeatedly.
      const nowMs = Date.now();
      negativeCache.set(deviceId, {
        reason: err.reason,
        expiresAt: nowMs + NEGATIVE_CACHE_TTL_MS,
        nextRecheckAt: nowMs + NEGATIVE_CACHE_RECHECK_INTERVAL_MS,
      });
    }
    throw err;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

// ── Internal activation logic ─────────────────────────────────────────────────

async function _runActivation(
  deviceId: string,
  options: EnsureSemanticsOptions | undefined,
  hardDeadline: number,
): Promise<boolean> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const minNodes = options?.minNodes ?? MIN_NODE_THRESHOLD;
  const useVMServiceFallback = options?.useVMServiceFallback ?? true;
  const bridge = getAccessibilityBridge();
  const deadline = Math.min(Date.now() + timeout, hardDeadline);

  // B. Quick check — tree already populated?
  if (await treeIsPopulated(bridge, deviceId, minNodes)) {
    return true;
  }

  // C. Simctl activation (cheap, works for debug + release).
  await tryActivateViaSimctl(deviceId);

  // Split the remaining budget: reserve roughly half for the simctl path,
  // leave the other half for a VM Service round-trip. This way we don't
  // block the full timeout on a Flutter app that refuses to populate via
  // defaults write alone.
  const simctlDeadline = useVMServiceFallback
    ? Date.now() + Math.max(POLL_INTERVAL_MS, Math.floor(timeout / 2))
    : deadline;

  if (await pollUntilPopulated(bridge, deviceId, minNodes, Math.min(simctlDeadline, hardDeadline))) {
    return true;
  }

  // D. Dart VM Service fallback — debug/profile builds only.
  if (useVMServiceFallback && Date.now() < deadline) {
    const vmResult = await tryActivateViaVMService(deviceId, options?.bundleId);
    if (vmResult === 'no-dds') {
      throw new FlutterSemanticsUnavailableError(
        'no-dds',
        'Flutter VM Service is reachable but the compile/evaluate service (DDS) is absent — ' +
          'the app was likely launched via `xcrun simctl launch` instead of `flutter run`. ' +
          'Flutter Semantics require DDS to be activated via the VM Service path.',
      );
    }
    if (await pollUntilPopulated(bridge, deviceId, minNodes, deadline)) {
      return true;
    }
  }

  // E. Give up — activation timed out within the per-call budget.
  // The hard-timeout race will fire separately if that budget is also exceeded;
  // if we get here first it means the per-call timeout elapsed before the hard
  // ceiling. Either way, surface a timeout error.
  throw new FlutterSemanticsUnavailableError(
    'timeout',
    `Flutter Semantics did not activate within ${timeout} ms. ` +
      'The app may be a release build or have been launched without `flutter run`.',
  );
}

/** Poll the AX bridge until the tree has `minNodes` nodes or the deadline passes. */
async function pollUntilPopulated(
  bridge: ReturnType<typeof getAccessibilityBridge>,
  deviceId: string,
  minNodes: number,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await treeIsPopulated(bridge, deviceId, minNodes)) {
      return true;
    }
  }
  return false;
}

async function treeIsPopulated(
  bridge: ReturnType<typeof getAccessibilityBridge>,
  deviceId: string,
  minNodes: number,
): Promise<boolean> {
  try {
    const tree = await bridge.dumpTree({ deviceId, maxDepth: 4 });
    return countNodes(tree) >= minNodes;
  } catch {
    return false;
  }
}

async function tryActivateViaSimctl(deviceId: string): Promise<void> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('xcrun', [
      'simctl', 'spawn', deviceId,
      'defaults', 'write', 'com.apple.Accessibility',
      'AccessibilityEnabled', '-bool', 'YES',
    ], { timeout: 5000 });
  } catch {
    // Fall through — caller will decide whether to keep polling or escalate
    // to the VM Service path.
  }
}

/**
 * Try to materialise Flutter's semantics tree by talking to the Dart VM
 * Service directly. Only works for debug/profile builds (release builds
 * strip the VM Service).
 *
 * Returns:
 *   - `'ok'` when the VM Service call succeeded (tree should now be populated)
 *   - `'no-dds'` when the VM is reachable but rejects evaluate with code 113
 *   - `'unavailable'` when the VM Service is not discoverable or unreachable
 */
async function tryActivateViaVMService(
  deviceId: string,
  bundleId: string | undefined,
): Promise<'ok' | 'no-dds' | 'unavailable'> {
  let client: { disconnect: () => Promise<void> } | undefined;
  try {
    const { discoverVMServiceUrl } = await import('../flutter/vm-service-discovery');
    const vmServiceUrl = await discoverVMServiceUrl(deviceId, {
      bundleId,
      timeout: VM_SERVICE_DISCOVERY_TIMEOUT_MS,
    });
    if (!vmServiceUrl) return 'unavailable';

    const { FlutterVMClient } = await import('../flutter/vm-service-client');
    const vmClient = new FlutterVMClient();
    client = vmClient;

    await vmClient.connect({
      vmServiceUrl,
      deviceId,
      bundleId,
      timeout: VM_SERVICE_CONNECT_TIMEOUT_MS,
    });

    // Probe whether compile/evaluate is available (requires DDS).
    // Apps launched via `xcrun simctl launch` expose the raw VM Service
    // socket but without the frontend compiler — probeEvaluateCompile will
    // return `{ available: false, reason: 'compile-error-113' }`.
    if ('probeEvaluateCompile' in vmClient && typeof (vmClient as unknown as { probeEvaluateCompile: () => Promise<unknown> }).probeEvaluateCompile === 'function') {
      const probe = await (vmClient as unknown as {
        probeEvaluateCompile: () => Promise<
          | { available: true }
          | { available: false; reason: string; message: string }
        >;
      }).probeEvaluateCompile();
      if (!probe.available && probe.reason === 'compile-error-113') {
        return 'no-dds';
      }
    }

    // Dumping the semantics tree forces Flutter to materialise it. The
    // native AX bridge should then see populated nodes on the next read.
    await vmClient.getSemanticsTree();
    return 'ok';
  } catch {
    // Debug/profile VM Service may be unavailable (release build, URL
    // rotated, WebSocket refused, etc.). Fall through silently.
    return 'unavailable';
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
