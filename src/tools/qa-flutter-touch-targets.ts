/**
 * qa_flutter_touch_targets — Check minimum tap target sizes for Flutter apps.
 *
 * Material Design guidelines require minimum 48x48dp for interactive elements.
 * This detector reads the accessibility tree and flags elements that are too small.
 */

import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';

const DEFAULT_MIN_SIZE = 48;
const INTERACTIVE_ROLES = [
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab',
];

interface TouchTargetViolation {
  role: string;
  label?: string;
  identifier?: string;
  path: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

export function registerQaFlutterTouchTargetsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_touch_targets',
      description:
        'Check that all interactive elements in a Flutter/native app meet minimum tap target size ' +
        '(48x48dp per Material Design / WCAG 2.5.8). Reads the accessibility tree and flags violations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          min_size: {
            type: 'number',
            description: 'Minimum tap target size in points (default: 48 per Material Design)',
          },
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

        const minSize = (params.min_size as number | undefined) ?? DEFAULT_MIN_SIZE;
        const bridge = getAccessibilityBridge();
        const tree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        const violations: TouchTargetViolation[] = [];
        let totalInteractive = 0;

        findViolations(tree, minSize, violations, { total: 0 });
        countInteractive(tree, { count: 0 });
        totalInteractive = countInteractiveNodes(tree);

        const passed = violations.length === 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              detector: 'qa_flutter_touch_targets',
              passed,
              min_size: minSize,
              total_interactive: totalInteractive,
              violations_count: violations.length,
              violations: violations.slice(0, 20), // Limit output
              summary: passed
                ? `All ${totalInteractive} interactive elements meet ${minSize}dp minimum.`
                : `${violations.length} of ${totalInteractive} interactive elements are smaller than ${minSize}dp.`,
            }, null, 2),
          }],
          isError: !passed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_touch_targets] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}

function isInteractive(node: AXNode): boolean {
  return INTERACTIVE_ROLES.some(
    (r) => node.role === r || node.role === r.replace('AX', ''),
  );
}

function countInteractiveNodes(node: AXNode): number {
  let count = 0;
  if (isInteractive(node) && node.visible) count++;
  if (node.children) {
    for (const child of node.children) {
      count += countInteractiveNodes(child);
    }
  }
  return count;
}

function findViolations(
  node: AXNode,
  minSize: number,
  violations: TouchTargetViolation[],
  _counter: { total: number },
): void {
  if (isInteractive(node) && node.visible) {
    const { width, height } = node.frame;
    const issues: string[] = [];

    if (width > 0 && width < minSize) {
      issues.push(`width ${Math.round(width)}dp < ${minSize}dp`);
    }
    if (height > 0 && height < minSize) {
      issues.push(`height ${Math.round(height)}dp < ${minSize}dp`);
    }

    if (issues.length > 0) {
      violations.push({
        role: node.role,
        label: node.label,
        identifier: node.identifier,
        path: node.path,
        frame: node.frame,
        issue: issues.join(', '),
      });
    }
  }

  if (node.children) {
    for (const child of node.children) {
      findViolations(child, minSize, violations, _counter);
    }
  }
}

function countInteractive(node: AXNode, counter: { count: number }): void {
  if (isInteractive(node) && node.visible) counter.count++;
  if (node.children) {
    for (const child of node.children) {
      countInteractive(child, counter);
    }
  }
}
