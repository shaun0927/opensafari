/**
 * Foreground probe — infer the bundle id that owns the current foreground
 * surface of a booted iOS Simulator.
 *
 * Used by `app_tap` (and future tools) to detect the side effect of a tap
 * that accidentally drops the calling app into the background — for example
 * a raw coordinate tap near the home-indicator band that is interpreted as
 * a swipe-home gesture (see issue #644).
 *
 * The probe layers three signals in order of decreasing trust:
 *   1. AX-tree classification (shared with `classifyNativeContext`). A
 *      SpringBoard/Simulator-chrome match is treated as verified.
 *   2. The `simctl spawn launchctl list` running-app list. When the tree
 *      looks like app content AND exactly one non-Apple bundle is running,
 *      that bundle is returned with heuristic confidence.
 *   3. Otherwise the probe returns `null`; callers should treat this as
 *      "cannot confirm" and avoid acting on the ambiguous result.
 *
 * The probe is deliberately stateless: callers that need repeated answers
 * inside a single tool invocation should cache the result themselves
 * instead of relying on module-level memoisation, which would cross
 * deviceId boundaries.
 */

import type { AccessibilityBridge } from '../native/accessibility-bridge';
import type { SimulatorManager } from '../simulator';
import { classifyNativeContext } from './native-app-context';

export type ForegroundConfidence = 'verified' | 'heuristic' | 'unknown';

export interface ForegroundProbeResult {
  /**
   * Bundle identifier of the foreground surface, or null when the probe
   * cannot confidently pick one. `"com.apple.springboard"` is returned for
   * SpringBoard; `null` is returned for the Simulator chrome window or
   * when multiple candidate apps are running.
   */
  bundleId: string | null;
  /** How much the caller should trust the reported bundle id. */
  confidence: ForegroundConfidence;
  /** Short debug hint (e.g. "ax:springboard", "running-apps:single"). */
  source: string;
}

export interface GetFrontmostBundleIdParams {
  deviceId: string;
  bridge: AccessibilityBridge;
  manager: SimulatorManager;
  /** Optional maxDepth for the AX dump; defaults to 4 (classification only). */
  maxDepth?: number;
}

const APPLE_SYSTEM_PREFIXES = [
  'com.apple.',
];

const IGNORED_RUNNING_APP_EXACT = new Set<string>([
  // Rarely frontmost but commonly running on a booted simulator.
  'com.apple.Spotlight',
  'com.apple.springboard',
  'com.apple.mobilecal',
  'com.apple.Preferences',
  'com.apple.mobilesafari',
]);

function isCandidateUserApp(bundleId: string): boolean {
  if (!bundleId) return false;
  if (IGNORED_RUNNING_APP_EXACT.has(bundleId)) return false;
  return !APPLE_SYSTEM_PREFIXES.some((prefix) => bundleId.startsWith(prefix));
}

/**
 * Report the bundle id that currently owns the foreground surface.
 *
 * Never throws for the normal "cannot determine" case — instead returns
 * `{ bundleId: null, confidence: 'unknown' }`. Unexpected errors from the
 * AX bridge or simctl still propagate so the caller can decide whether
 * to treat them as fatal.
 */
export async function getFrontmostBundleId(
  params: GetFrontmostBundleIdParams,
): Promise<ForegroundProbeResult> {
  const { deviceId, bridge, manager, maxDepth = 4 } = params;

  let treeClassification: ReturnType<typeof classifyNativeContext> | null = null;
  try {
    const tree = await bridge.dumpTree({ deviceId, maxDepth });
    treeClassification = classifyNativeContext(tree);
  } catch (err) {
    // Dump failure is informative but not fatal — fall through to the
    // running-apps heuristic. Log so regression investigations have a
    // breadcrumb.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[foreground-probe] AX dump failed (${message}); falling back to running-apps.`,
    );
  }

  if (treeClassification?.sourceKind === 'springboard') {
    return {
      bundleId: 'com.apple.springboard',
      confidence: 'verified',
      source: 'ax:springboard',
    };
  }

  if (treeClassification?.sourceKind === 'simulator-window') {
    return {
      bundleId: null,
      confidence: 'verified',
      source: 'ax:simulator-window',
    };
  }

  let running: Array<{ label: string; pid: number }> = [];
  try {
    running = await manager.listRunningApps(deviceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[foreground-probe] listRunningApps failed (${message}); returning unknown.`,
    );
    return { bundleId: null, confidence: 'unknown', source: 'running-apps:error' };
  }

  const userApps = running
    .map((app) => app.label)
    .filter(isCandidateUserApp);

  if (userApps.length === 1) {
    return {
      bundleId: userApps[0],
      confidence: 'heuristic',
      source: 'running-apps:single',
    };
  }

  if (userApps.length === 0) {
    // No user app running and AX did not classify SpringBoard — most
    // likely the simulator is on the lock screen or booting.
    return { bundleId: null, confidence: 'unknown', source: 'running-apps:empty' };
  }

  return {
    bundleId: null,
    confidence: 'unknown',
    source: `running-apps:ambiguous:${userApps.length}`,
  };
}
