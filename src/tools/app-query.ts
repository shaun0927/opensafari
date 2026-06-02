import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, activateSemanticsOrWarn } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import {
  activateAndClassify,
  createContextMismatchError,
  NativeContextMeta,
} from './native-app-context';

export function registerAppQueryTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_query',
      description: 'Query native app UI elements by accessibility identifier, label, text, or role. Returns matching elements with metadata. Reports ambiguity when an identifier matches multiple elements. Compatible with Flutter apps — the tool auto-activates Flutter\'s lazy Semantics tree so `Semantics(label:/identifier:)` widgets are queryable.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          identifier: {
            type: 'string',
            description: 'Accessibility identifier (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label (case-insensitive substring)',
          },
          text: {
            type: 'string',
            description: 'Text content in value or label (case-insensitive substring)',
          },
          role: {
            type: 'string',
            description: 'Accessibility role (e.g. "AXButton", "AXStaticText", "Button")',
          },
          device_id: {
            type: 'string',
            description: 'Simulator device UDID (defaults to active device)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target Flutter app bundle ID. Only used to disambiguate Dart VM Service discovery when multiple Flutter apps run on the same simulator.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default: 50)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const identifier = params.identifier as string | undefined;
      const label = params.label as string | undefined;
      const text = params.text as string | undefined;
      const role = params.role as string | undefined;

      if (!identifier && !label && !text && !role) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: at least one query parameter (identifier, label, text, or role) is required',
          }],
          isError: true,
        };
      }

      try {
        const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId() ?? undefined;
        const bundleId = params.bundle_id as string | undefined;
        const maxResults = params.max_results as number | undefined;

        const bridge = getAccessibilityBridge();
        let meta: NativeContextMeta = {
          requestedBundleId: bundleId,
          deviceId,
          sourceKind: 'unknown',
          heuristics: ['not-requested'],
          activationAttempted: false,
          activationRetries: 0,
        };
        let semanticsWarning: string | undefined;
        if (bundleId) {
          const context = await activateAndClassify({
            bridge,
            deviceId,
            bundleId,
            ensureSemanticsActive: () => ensureSemanticsActive(deviceId, { bundleId }),
          });
          meta = context.meta;
          if (meta.sourceKind !== 'target-app') {
            throw createContextMismatchError(meta);
          }
        } else {
          semanticsWarning = (await activateSemanticsOrWarn(deviceId, { bundleId })).warning;
        }

        let result = await bridge.query(
          { identifier, label, text, role },
          { deviceId, maxResults },
        );
        let queryRecovery:
          | {
            retriedAfterForceRefresh: boolean;
            recovered: boolean;
            matchStrategy?: 'native' | 'relaxed-tree-scan';
          }
          | undefined;
        let queryDiagnostics:
          | {
            nodeCount: number;
            visibleSummary: {
              buttonLabels: string[];
              staticTexts: string[];
              textFieldLabels: string[];
            };
          }
          | undefined;

        if (result.total === 0) {
          await ensureSemanticsActive(deviceId, {
            bundleId,
            forceRefresh: true,
          });
          result = await bridge.query(
            { identifier, label, text, role },
            { deviceId, maxResults },
          );
          queryRecovery = {
            retriedAfterForceRefresh: true,
            recovered: result.total > 0,
            matchStrategy: result.total > 0 ? 'native' : undefined,
          };

          if (result.total === 0) {
            try {
              const tree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
              const relaxedMatches = findRelaxedMatches(
                tree,
                { identifier, label, text, role },
                maxResults ?? 50,
              );
              if (relaxedMatches.length > 0) {
                result = {
                  matches: relaxedMatches,
                  total: relaxedMatches.length,
                  query: { identifier, label, text, role },
                  ambiguous: Boolean(identifier) && relaxedMatches.length > 1,
                };
                queryRecovery = {
                  retriedAfterForceRefresh: true,
                  recovered: true,
                  matchStrategy: 'relaxed-tree-scan',
                };
              }
              queryDiagnostics = buildQueryDiagnostics(tree);
            } catch {
              // Diagnostics are best-effort. If tree dumping fails we still
              // return the query response without an additional fatal error.
            }
          }
        }

        if (result.total === 0) {
          console.error(
            `[app_query] no match for fields=${JSON.stringify({ identifier, label, text, role })}; ` +
            `searched=identifier|label|value|role; ` +
            `visibleSummary=${JSON.stringify(queryDiagnostics?.visibleSummary ?? null)}`,
          );
        }

        if (result.ambiguous) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                warning: `Ambiguous query: identifier "${identifier}" matched ${result.total} elements. Use a more specific query or inspect individual paths.`,
                _meta: {
                  context: meta,
                  queryRecovery,
                  queryDiagnostics,
                },
                ...result,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              // Surface the empty-tree cause only when the query ultimately
              // found nothing — a recovered match means semantics did populate.
              ...(semanticsWarning && result.total === 0 ? { semanticsWarning } : {}),
              _meta: {
                context: meta,
                queryRecovery,
                queryDiagnostics,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}

function buildQueryDiagnostics(tree: AXNode): {
  nodeCount: number;
  visibleSummary: {
    buttonLabels: string[];
    staticTexts: string[];
    textFieldLabels: string[];
  };
} {
  const buttons = new Set<string>();
  const texts = new Set<string>();
  const textFields = new Set<string>();

  const stack: AXNode[] = [tree];
  let nodeCount = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodeCount += 1;
    if (node.visible !== false) {
      if (/AXButton/.test(node.role) && node.label) {
        buttons.add(node.label);
      }
      if (/AX(TextField|SecureTextField|TextArea)/.test(node.role)) {
        if (node.label) textFields.add(node.label);
        if (node.value) textFields.add(node.value);
      }
      if (/AXStaticText/.test(node.role)) {
        if (node.label) texts.add(node.label);
        if (node.value) texts.add(node.value);
      }
    }
    for (const child of node.children ?? []) {
      stack.push(child);
    }
  }

  return {
    nodeCount,
    visibleSummary: {
      buttonLabels: [...buttons].slice(0, 8),
      staticTexts: [...texts].slice(0, 8),
      textFieldLabels: [...textFields].slice(0, 8),
    },
  };
}

function findRelaxedMatches(
  tree: AXNode,
  query: {
    identifier?: string;
    label?: string;
    text?: string;
    role?: string;
  },
  maxResults: number,
): AXNode[] {
  const scored: Array<{ node: AXNode; score: number; direct: boolean }> = [];

  function visit(node: AXNode): {
    subtreeText: string[];
    matchedNodes: number;
  } {
    let subtreeText = collectNodeSearchText(node);
    let matchedNodes = 0;
    let descendantMatched = false;

    for (const child of node.children ?? []) {
      const childResult = visit(child);
      subtreeText = subtreeText.concat(childResult.subtreeText);
      matchedNodes += childResult.matchedNodes;
      descendantMatched = descendantMatched || childResult.matchedNodes > 0;
    }

    const direct = nodeMatchesRelaxedQuery(node, query, subtreeText);
    if (direct && !descendantMatched && node.visible !== false) {
      const score = scoreRelaxedMatch(node, subtreeText);
      scored.push({ node: flattenNode(node), score, direct });
      matchedNodes += 1;
    }

    return { subtreeText, matchedNodes };
  }

  visit(tree);

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((entry) => entry.node);
}

function nodeMatchesRelaxedQuery(
  node: AXNode,
  query: {
    identifier?: string;
    label?: string;
    text?: string;
    role?: string;
  },
  subtreeText: string[],
): boolean {
  if (query.identifier && node.identifier !== query.identifier) {
    return false;
  }
  if (query.role && node.role !== query.role && node.role !== `AX${query.role}`) {
    return false;
  }
  if (query.label) {
    const labelNeedle = normalizeQueryText(query.label);
    if (!subtreeText.some((value) => normalizeQueryText(value).includes(labelNeedle))) {
      return false;
    }
  }
  if (query.text) {
    const textNeedle = normalizeQueryText(query.text);
    if (!subtreeText.some((value) => normalizeQueryText(value).includes(textNeedle))) {
      return false;
    }
  }
  return true;
}

function collectNodeSearchText(node: AXNode): string[] {
  return [node.label, node.value, node.identifier].filter(
    (value): value is string => Boolean(value && value.trim().length > 0),
  );
}

function normalizeQueryText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function scoreRelaxedMatch(node: AXNode, subtreeText: string[]): number {
  const ownTextCount = collectNodeSearchText(node).length;
  const descendantTextCount = Math.max(0, subtreeText.length - ownTextCount);
  let score = 0;

  if (node.identifier) score += 6;
  if (node.label) score += 4;
  if (/AX(TextField|SecureTextField|TextArea)/.test(node.role)) score += 5;
  if (/AXButton/.test(node.role)) score += 4;
  if (/AXStaticText/.test(node.role)) score += 3;
  if (node.enabled) score += 1;
  if (node.focused) score += 1;
  score -= descendantTextCount;

  return score;
}

function flattenNode(node: AXNode): AXNode {
  return {
    ...node,
    children: undefined,
  };
}
