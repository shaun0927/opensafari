/**
 * qa_flutter_semantics — Check accessibility/semantics coverage for Flutter apps.
 *
 * Verifies that interactive elements have proper accessibility labels and
 * identifiers. Reports coverage percentage and flags unlabeled elements.
 */

import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { getFlutterVMClient } from '../flutter';

const INTERACTIVE_ROLES = [
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab', 'AXImage',
];

// Selector-quality scoring follows qa_flutter_full_audit's taxonomy:
// images are semantics-relevant, but not automatically automation targets.
const SELECTOR_INTERACTIVE_ROLES = INTERACTIVE_ROLES.filter((role) => role !== 'AXImage');

interface SemanticsIssue {
  role: string;
  path: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

export interface SelectorQualityFinding {
  severity: 'info' | 'warning' | 'error';
  category:
    | 'missing_identifier'
    | 'duplicate_identifier'
    | 'duplicate_label'
    | 'label_only_selector'
    | 'missing_role';
  node?: {
    path?: string;
    role?: string;
    label?: string;
    identifier?: string;
    frame?: AXNode['frame'];
  };
  recommendation: string;
}

export interface FlutterSelectorQualityReport {
  schemaVersion: '1';
  summary: {
    totalNodes: number;
    interactiveNodes: number;
    nodesWithIdentifier: number;
    nodesWithLabelOnly: number;
    duplicateIdentifiers: number;
    duplicateLabels: number;
    fragileSelectorCount: number;
    automationReadinessScore: number;
  };
  findings: SelectorQualityFinding[];
  enrichment: {
    flutterVmConnected: boolean;
    widgetTreeUsed: boolean;
  };
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
          include_selector_quality: {
            type: 'boolean',
            description: 'Include Flutter automation selector-quality findings (default true).',
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
          throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device.');
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
        const selectorQuality = params.include_selector_quality === false
          ? undefined
          : analyzeSelectorQuality(tree, { flutterVmConnected: getFlutterVMClient(deviceId).isConnected() });

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
              selector_quality: selectorQuality,
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

export function analyzeSelectorQuality(
  tree: AXNode,
  enrichment: { flutterVmConnected: boolean; widgetTreeUsed?: boolean } = { flutterVmConnected: false },
): FlutterSelectorQualityReport {
  const allNodes: AXNode[] = [];
  const interactive: AXNode[] = [];
  const identifiers = new Map<string, AXNode[]>();
  const labels = new Map<string, AXNode[]>();

  function walk(node: AXNode): void {
    allNodes.push(node);
    if (isSelectorInteractive(node) && node.visible) {
      interactive.push(node);
      if (node.identifier?.trim()) {
        addToMap(identifiers, node.identifier.trim(), node);
      }
      if (node.label?.trim()) {
        addToMap(labels, node.label.trim(), node);
      }
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(tree);

  const findings: SelectorQualityFinding[] = [];
  for (const node of interactive) {
    const hasIdentifier = Boolean(node.identifier?.trim());
    const hasLabel = Boolean(node.label?.trim());
    if (!hasIdentifier) {
      findings.push({
        severity: hasLabel ? 'warning' : 'error',
        category: hasLabel ? 'label_only_selector' : 'missing_identifier',
        node: shapeNode(node),
        recommendation: hasLabel
          ? 'Add Semantics(identifier: "...") so automation does not depend on locale/user-visible text.'
          : 'Add Semantics(identifier: "...", label: "...") or an equivalent accessibility identifier for this interactive widget.',
      });
    }
    if (!node.role?.trim()) {
      findings.push({
        severity: 'warning',
        category: 'missing_role',
        node: shapeNode(node),
        recommendation: 'Expose an accessibility role/trait so agents can distinguish buttons, fields, tabs, and custom controls.',
      });
    }
  }

  for (const [identifier, nodes] of identifiers) {
    if (nodes.length > 1) {
      findings.push({
        severity: 'error',
        category: 'duplicate_identifier',
        node: shapeNode(nodes[0]),
        recommendation: `Identifier "${identifier}" appears ${nodes.length} times. Use unique Semantics(identifier:) values for automation targets.`,
      });
    }
  }
  for (const [label, nodes] of labels) {
    if (nodes.length > 1) {
      findings.push({
        severity: 'warning',
        category: 'duplicate_label',
        node: shapeNode(nodes[0]),
        recommendation: `Label "${label}" appears ${nodes.length} times. Prefer identifiers for disambiguation or include more specific labels.`,
      });
    }
  }

  const nodesWithIdentifier = interactive.filter((n) => Boolean(n.identifier?.trim())).length;
  const nodesWithLabelOnly = interactive.filter((n) => !n.identifier?.trim() && Boolean(n.label?.trim())).length;
  const duplicateIdentifiers = [...identifiers.values()].filter((nodes) => nodes.length > 1).length;
  const duplicateLabels = [...labels.values()].filter((nodes) => nodes.length > 1).length;
  const fragileSelectorCount = findings.filter((f) => f.severity !== 'info').length;
  const automationReadinessScore = interactive.length === 0
    ? 100
    : Math.max(0, Math.round(100 - (fragileSelectorCount / Math.max(1, interactive.length)) * 100));

  return {
    schemaVersion: '1',
    summary: {
      totalNodes: allNodes.length,
      interactiveNodes: interactive.length,
      nodesWithIdentifier,
      nodesWithLabelOnly,
      duplicateIdentifiers,
      duplicateLabels,
      fragileSelectorCount,
      automationReadinessScore,
    },
    findings,
    enrichment: {
      flutterVmConnected: enrichment.flutterVmConnected,
      widgetTreeUsed: Boolean(enrichment.widgetTreeUsed),
    },
  };
}

function isSelectorInteractive(node: AXNode): boolean {
  return SELECTOR_INTERACTIVE_ROLES.some(
    (r) => node.role === r || node.role === r.replace('AX', ''),
  );
}

function addToMap(map: Map<string, AXNode[]>, key: string, node: AXNode): void {
  const existing = map.get(key) ?? [];
  existing.push(node);
  map.set(key, existing);
}

function shapeNode(node: AXNode): SelectorQualityFinding['node'] {
  return {
    path: node.path,
    role: node.role,
    label: node.label,
    identifier: node.identifier,
    frame: node.frame,
  };
}
