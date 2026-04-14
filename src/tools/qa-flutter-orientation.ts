/**
 * qa_flutter_orientation — Verify Flutter/native app layout adapts to rotation.
 *
 * Compares accessibility trees in portrait and landscape modes to detect
 * overflow, missing elements, and layout issues. Restores the original
 * orientation after the check.
 */

import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';

const INTERACTIVE_ROLES = [
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab',
];

// Default landscape screen dimensions for iPhone 16 (points).
// Overflow is only checked in landscape — portrait is the app's natural
// layout, so any portrait overflow would be caught by other QA passes.
const LANDSCAPE_WIDTH = 852;
const LANDSCAPE_HEIGHT = 393;

// Tolerance in points for overflow detection
const OVERFLOW_TOLERANCE = 10;

interface OverflowViolation {
  role: string;
  label?: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

export function registerQaFlutterOrientationTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_orientation',
      description:
        'Verify Flutter/native app layout adapts correctly to portrait/landscape rotation. ' +
        'Compares accessibility trees and detects overflow, missing elements, and layout issues.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }

        const bridge = getAccessibilityBridge();
        const simctl = new SimctlExecutor();

        // 1. Dump portrait tree (assume current orientation is portrait)
        const portraitTree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        // 2. Rotate to landscape
        await simctl.exec(['io', deviceId, 'setorientation', 'landscapeLeft']);
        await sleep(1500);

        // 3. Dump landscape tree
        const landscapeTree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        // 4. Restore portrait orientation
        await simctl.exec(['io', deviceId, 'setorientation', 'portrait']);

        // 5. Analyze differences
        const portraitInteractive = countInteractiveNodes(portraitTree);
        const landscapeInteractive = countInteractiveNodes(landscapeTree);

        const portraitLabels = new Set<string>();
        collectLabels(portraitTree, portraitLabels);

        const landscapeLabels = new Set<string>();
        collectLabels(landscapeTree, landscapeLabels);

        // Elements present in portrait but missing in landscape
        const missingInLandscape: string[] = [];
        for (const label of portraitLabels) {
          if (!landscapeLabels.has(label)) {
            missingInLandscape.push(label);
          }
        }

        // Check for overflow in landscape mode
        const overflowViolations: OverflowViolation[] = [];
        findOverflow(landscapeTree, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT, overflowViolations);

        // Detect orientation lock — if frame positions are identical the app
        // is not responding to rotation
        const orientationLocked = isOrientationLocked(portraitTree, landscapeTree);

        // Determine overall pass/fail
        const passed =
          missingInLandscape.length === 0 &&
          overflowViolations.length === 0 &&
          !orientationLocked;

        let summary: string;
        if (orientationLocked) {
          summary = 'Orientation appears locked — portrait and landscape trees have identical frame positions. Skipped layout checks.';
        } else if (passed) {
          summary = `Layout adapts correctly. ${portraitInteractive} interactive elements in portrait, ${landscapeInteractive} in landscape. No overflow or missing elements detected.`;
        } else {
          const parts: string[] = [];
          if (missingInLandscape.length > 0) {
            parts.push(`${missingInLandscape.length} element(s) missing in landscape`);
          }
          if (overflowViolations.length > 0) {
            parts.push(`${overflowViolations.length} element(s) overflow screen bounds in landscape`);
          }
          summary = `Layout issues detected: ${parts.join('; ')}.`;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              detector: 'qa_flutter_orientation',
              passed,
              portrait_interactive_count: portraitInteractive,
              landscape_interactive_count: landscapeInteractive,
              missing_in_landscape: missingInLandscape,
              overflow_violations: overflowViolations.slice(0, 20),
              orientation_locked: orientationLocked,
              summary,
            }, null, 2),
          }],
          isError: !passed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_orientation] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countInteractiveNodes(node: AXNode): number {
  let count = 0;
  if (INTERACTIVE_ROLES.includes(node.role) && node.visible) count++;
  if (node.children) {
    for (const c of node.children) count += countInteractiveNodes(c);
  }
  return count;
}

function collectLabels(node: AXNode, labels: Set<string>): void {
  if (node.label && node.visible) labels.add(node.label);
  if (node.children) {
    for (const c of node.children) collectLabels(c, labels);
  }
}

function findOverflow(
  node: AXNode,
  screenWidth: number,
  screenHeight: number,
  violations: OverflowViolation[],
): void {
  if (node.visible && node.frame) {
    const right = node.frame.x + node.frame.width;
    const bottom = node.frame.y + node.frame.height;
    if (right > screenWidth + OVERFLOW_TOLERANCE || bottom > screenHeight + OVERFLOW_TOLERANCE) {
      violations.push({
        role: node.role,
        label: node.label,
        frame: node.frame,
        issue: `extends beyond screen (right: ${Math.round(right)}, bottom: ${Math.round(bottom)})`,
      });
    }
  }
  if (node.children) {
    for (const c of node.children) findOverflow(c, screenWidth, screenHeight, violations);
  }
}

/**
 * Detect orientation lock by comparing top-level frame positions.
 * If the root frames are identical in both orientations, the app
 * likely locks orientation and ignores the rotation.
 */
function isOrientationLocked(portrait: AXNode, landscape: AXNode): boolean {
  // Compare the root node frames — if they are identical the app
  // did not respond to the rotation at all.
  if (
    portrait.frame.x === landscape.frame.x &&
    portrait.frame.y === landscape.frame.y &&
    portrait.frame.width === landscape.frame.width &&
    portrait.frame.height === landscape.frame.height
  ) {
    // Also compare children frames to be sure
    if (!portrait.children || !landscape.children) return true;
    if (portrait.children.length !== landscape.children.length) return false;
    for (let i = 0; i < portrait.children.length; i++) {
      const p = portrait.children[i];
      const l = landscape.children[i];
      if (
        p.frame.x !== l.frame.x ||
        p.frame.y !== l.frame.y ||
        p.frame.width !== l.frame.width ||
        p.frame.height !== l.frame.height
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}
