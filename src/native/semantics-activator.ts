/**
 * Flutter Semantics Activator
 *
 * Flutter lazily builds its accessibility/semantics tree — it only populates
 * native UIAccessibilityElement objects when an assistive technology (e.g.
 * VoiceOver) is detected. This module forces semantics activation so that
 * `app_tree`, `app_query`, and `app_inspect` return a populated tree for
 * Flutter apps.
 *
 * Strategy:
 * 1. Quick-check: if the tree already has enough nodes, skip activation.
 * 2. Enable the Accessibility Inspector flag via `simctl spawn defaults write`
 *    — this triggers Flutter's semantics without full VoiceOver side effects.
 * 3. Poll until the tree populates or timeout.
 */

import { getAccessibilityBridge } from './accessibility-bridge';
import type { AXNode } from './ax-types';

const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 300;
const MIN_NODE_THRESHOLD = 5;

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
 * Returns `true` if the accessibility tree has enough nodes (semantics active),
 * `false` if activation failed or timed out.
 *
 * This is a no-op for native (non-Flutter) apps that already expose a full
 * accessibility tree.
 */
export async function ensureSemanticsActive(
  deviceId: string,
  options?: { timeout?: number; minNodes?: number },
): Promise<boolean> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const minNodes = options?.minNodes ?? MIN_NODE_THRESHOLD;
  const bridge = getAccessibilityBridge();

  // Quick check: if tree already has enough nodes, semantics is active
  try {
    const tree = await bridge.dumpTree({ deviceId, maxDepth: 4 });
    if (countNodes(tree) >= minNodes) {
      return true;
    }
  } catch {
    // Tree dump failed — device may not be ready, continue with activation attempt
  }

  // Activate accessibility inspection via simctl defaults write.
  // This sets the flag that triggers Flutter's SemanticsBinding to populate
  // the semantics tree, without enabling full VoiceOver spoken feedback.
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
    // If defaults write fails, still try polling — maybe semantics will populate naturally
  }

  // Poll until tree populates or timeout
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const tree = await bridge.dumpTree({ deviceId, maxDepth: 4 });
      if (countNodes(tree) >= minNodes) {
        return true;
      }
    } catch {
      // Continue polling
    }
  }

  // Timeout — semantics may not be available (release build without Semantics widgets)
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
