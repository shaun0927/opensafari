import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
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
          await ensureSemanticsActive(deviceId, { bundleId });
        }

        let result = await bridge.query(
          { identifier, label, text, role },
          { deviceId, maxResults },
        );
        let queryRecovery:
          | {
            retriedAfterForceRefresh: boolean;
            recovered: boolean;
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
          };

          if (result.total === 0) {
            try {
              const tree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
              queryDiagnostics = buildQueryDiagnostics(tree);
            } catch {
              // Diagnostics are best-effort. If tree dumping fails we still
              // return the query response without an additional fatal error.
            }
          }
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
