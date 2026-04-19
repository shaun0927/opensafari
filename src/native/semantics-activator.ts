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
 *   A. Quick-check: if the tree already has enough nodes, skip activation.
 *   B. Simctl activation: enable the macOS Accessibility Inspector flag via
 *      `xcrun simctl spawn defaults write`. This triggers Flutter's
 *      `SemanticsBinding` without full VoiceOver side effects.
 *   C. Dart VM Service fallback (debug/profile builds only): connect to the
 *      app's VM Service and call `debugDumpSemanticsTreeInTraversalOrder`,
 *      which forces Flutter to materialise the semantics tree even when the
 *      native accessibility flag did not propagate (e.g. when the activation
 *      flag was already set by a previous session and no rebuild fired).
 *   D. Graceful timeout: return `false` and let the caller decide.
 */

import { getAccessibilityBridge } from './accessibility-bridge';
import type { AXNode } from './ax-types';

const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 300;
const MIN_NODE_THRESHOLD = 5;
const VM_SERVICE_DISCOVERY_TIMEOUT_MS = 3000;
const VM_SERVICE_CONNECT_TIMEOUT_MS = 3000;

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

function flattenTree(node: AXNode, acc: AXNode[] = []): AXNode[] {
  acc.push(node);
  for (const child of node.children ?? []) {
    flattenTree(child, acc);
  }
  return acc;
}

const CHROME_LABELS = new Set([
  'Action',
  'Volume Up',
  'Volume Down',
  'Sleep/Wake',
  'Home',
  'Save Screen',
  'Rotate',
  'Capture Pointer',
  'Capture Keyboard',
]);

function isChromeValue(value: string): boolean {
  return /^iPhone\b/.test(value)
    || /^iPad\b/.test(value)
    || /^iOS \d/.test(value);
}

/**
 * Heuristic guard against simulator-chrome-only trees.
 *
 * A tree is considered "chrome-only" when:
 *   - it has a low node count,
 *   - it contains no identifiers,
 *   - it contains no obvious app roles like text fields,
 *   - every label/value is consistent with Simulator chrome,
 *   - AND the tree is rooted in Simulator chrome (either the root label
 *     matches the simulator device pattern like `iPhone 15 Pro -- iOS 17`,
 *     or at least one node carries a Simulator-chrome label).
 *
 * The root-label gate prevents minimal apps that happen to expose chrome-like
 * labels but run under a non-simulator root from being misclassified.
 */
export function isLikelyChromeOnlyTree(node: AXNode): boolean {
  const nodes = flattenTree(node);
  if (nodes.length > 20) return false;
  if (nodes.some((n) => Boolean(n.identifier))) return false;
  if (nodes.some((n) => /AX(TextField|SecureTextField|TextArea|WebArea)/.test(n.role))) {
    return false;
  }

  const meaningfulStrings = nodes.flatMap((n) => [n.label, n.value].filter(Boolean) as string[]);
  if (meaningfulStrings.length === 0) return false;

  const rootLabel = node.label ?? '';
  const rootMatchesSimulator = /^(iPhone|iPad).*--/i.test(rootLabel);
  const anyChromeLabel = nodes.some((n) => (n.label && CHROME_LABELS.has(n.label)));
  if (!rootMatchesSimulator && !anyChromeLabel) return false;

  return meaningfulStrings.every((value) =>
    CHROME_LABELS.has(value) || isChromeValue(value),
  );
}

/**
 * Attempt to activate Flutter semantics for a given simulator device.
 *
 * Returns `true` if the accessibility tree has enough nodes (semantics active),
 * `false` if activation failed or timed out.
 *
 * This is a no-op for native (non-Flutter) apps that already expose a full
 * accessibility tree.
 */
export async function ensureSemanticsActive(
  deviceId: string,
  options?: EnsureSemanticsOptions,
): Promise<boolean> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const minNodes = options?.minNodes ?? MIN_NODE_THRESHOLD;
  const useVMServiceFallback = options?.useVMServiceFallback ?? true;
  const bridge = getAccessibilityBridge();
  const deadline = Date.now() + timeout;

  // A. Quick check — tree already populated?
  if (await treeIsPopulated(bridge, deviceId, minNodes)) {
    return true;
  }

  // B. Simctl activation (cheap, works for debug + release).
  await tryActivateViaSimctl(deviceId);

  // Split the remaining budget: reserve roughly half for the simctl path,
  // leave the other half for a VM Service round-trip. This way we don't
  // block the full timeout on a Flutter app that refuses to populate via
  // defaults write alone.
  const simctlDeadline = useVMServiceFallback
    ? Date.now() + Math.max(POLL_INTERVAL_MS, Math.floor(timeout / 2))
    : deadline;

  if (await pollUntilPopulated(bridge, deviceId, minNodes, simctlDeadline)) {
    return true;
  }

  // C. Dart VM Service fallback — debug/profile builds only.
  if (useVMServiceFallback && Date.now() < deadline) {
    await tryActivateViaVMService(deviceId, options?.bundleId);
    if (await pollUntilPopulated(bridge, deviceId, minNodes, deadline)) {
      return true;
    }
  }

  // D. Give up gracefully.
  return false;
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
    return countNodes(tree) >= minNodes && !isLikelyChromeOnlyTree(tree);
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
 * strip the VM Service). Silent on any failure — the caller treats this
 * as best-effort.
 */
async function tryActivateViaVMService(
  deviceId: string,
  bundleId: string | undefined,
): Promise<void> {
  let client: { disconnect: () => Promise<void> } | undefined;
  try {
    const { discoverVMServiceUrl } = await import('../flutter/vm-service-discovery');
    const vmServiceUrl = await discoverVMServiceUrl(deviceId, {
      bundleId,
      timeout: VM_SERVICE_DISCOVERY_TIMEOUT_MS,
    });
    if (!vmServiceUrl) return;

    const { FlutterVMClient } = await import('../flutter/vm-service-client');
    const vmClient = new FlutterVMClient();
    client = vmClient;

    await vmClient.connect({
      vmServiceUrl,
      deviceId,
      bundleId,
      timeout: VM_SERVICE_CONNECT_TIMEOUT_MS,
    });

    // Dumping the semantics tree forces Flutter to materialise it. The
    // native AX bridge should then see populated nodes on the next read.
    await vmClient.getSemanticsTree();
  } catch {
    // Debug/profile VM Service may be unavailable (release build, URL
    // rotated, WebSocket refused, etc.). Fall through silently.
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
