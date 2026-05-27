/**
 * qa_flutter_semantics — Check accessibility/semantics coverage for Flutter apps.
 *
 * Verifies that interactive elements have proper accessibility labels and
 * identifiers. Reports coverage percentage and flags unlabeled elements.
 */

import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';

const INTERACTIVE_ROLES = [
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab', 'AXImage',
];

interface SemanticsIssue {
  role: string;
  path: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

export function registerQaFlutterSemanticsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_semantics',
      description:
        'Check accessibility/semantics coverage for a Flutter/native app. Verifies that interactive ' +
        'elements have proper accessibility labels and identifiers for screen readers and automation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          min_coverage: {
            type: 'number',
            description: 'Minimum acceptable coverage percentage (default: 80)',
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

        const minCoverage = (params.min_coverage as number | undefined) ?? 80;
        const bridge = getAccessibilityBridge();
        const tree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        const issues: SemanticsIssue[] = [];
        let totalInteractive = 0;
        let labeled = 0;
        let withIdentifier = 0;

        analyzeSemantics(tree, issues, {
          totalInteractive: 0,
          labeled: 0,
          withIdentifier: 0,
        });

        const stats = countSemantics(tree);
        totalInteractive = stats.totalInteractive;
        labeled = stats.labeled;
        withIdentifier = stats.withIdentifier;

        const coverage = totalInteractive > 0
          ? Math.round((labeled / totalInteractive) * 100)
          : 100;
        const identifierCoverage = totalInteractive > 0
          ? Math.round((withIdentifier / totalInteractive) * 100)
          : 100;
        const passed = coverage >= minCoverage;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              detector: 'qa_flutter_semantics',
              passed,
              coverage_percent: coverage,
              identifier_coverage_percent: identifierCoverage,
              min_coverage: minCoverage,
              total_interactive: totalInteractive,
              labeled,
              with_identifier: withIdentifier,
              issues_count: issues.length,
              issues: issues.slice(0, 20),
              summary: passed
                ? `Semantics coverage: ${coverage}% (${labeled}/${totalInteractive} elements labeled). Meets ${minCoverage}% threshold.`
                : `Semantics coverage: ${coverage}% (${labeled}/${totalInteractive} elements labeled). Below ${minCoverage}% threshold.`,
            }, null, 2),
          }],
          isError: !passed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_semantics] ${message}`);
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

function countSemantics(node: AXNode): { totalInteractive: number; labeled: number; withIdentifier: number } {
  let totalInteractive = 0;
  let labeled = 0;
  let withIdentifier = 0;

  function walk(n: AXNode): void {
    if (isInteractive(n) && n.visible) {
      totalInteractive++;
      if (n.label && n.label.trim().length > 0) labeled++;
      if (n.identifier && n.identifier.trim().length > 0) withIdentifier++;
    }
    if (n.children) {
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return { totalInteractive, labeled, withIdentifier };
}

function analyzeSemantics(
  node: AXNode,
  issues: SemanticsIssue[],
  _stats: { totalInteractive: number; labeled: number; withIdentifier: number },
): void {
  if (isInteractive(node) && node.visible) {
    const hasLabel = node.label && node.label.trim().length > 0;
    const hasIdentifier = node.identifier && node.identifier.trim().length > 0;

    if (!hasLabel && !hasIdentifier) {
      issues.push({
        role: node.role,
        path: node.path,
        frame: node.frame,
        issue: 'Missing both accessibility label and identifier',
      });
    } else if (!hasLabel) {
      issues.push({
        role: node.role,
        path: node.path,
        frame: node.frame,
        issue: 'Missing accessibility label (has identifier only)',
      });
    }
  }

  if (node.children) {
    for (const child of node.children) {
      analyzeSemantics(child, issues, _stats);
    }
  }
}
