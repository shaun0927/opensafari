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

        const result = await bridge.query(
          { identifier, label, text, role },
          { deviceId, maxResults },
        );

        let debug: Record<string, unknown> | undefined;
        if (result.total === 0) {
          debug = await collectNoMatchDebug(bridge, deviceId, { identifier, label, text, role });
          console.error(
            `[app_query] no match for fields=${JSON.stringify({ identifier, label, text, role })}; ` +
            `searched=identifier|label|value|role; candidates=${JSON.stringify(debug.candidates)}`,
          );
        }

        if (result.ambiguous) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                warning: `Ambiguous query: identifier "${identifier}" matched ${result.total} elements. Use a more specific query or inspect individual paths.`,
                _meta: { context: meta },
                debug,
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
              debug,
              _meta: { context: meta },
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

async function collectNoMatchDebug(
  bridge: ReturnType<typeof getAccessibilityBridge>,
  deviceId: string | undefined,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const tree = await bridge.dumpTree({ deviceId, maxDepth: 6 });
    const candidates = collectCandidateStrings(tree).slice(0, 10);
    return {
      searchedFields: ['identifier', 'label', 'value', 'role'],
      normalizedQuery: Object.fromEntries(
        Object.entries(query)
          .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
          .map(([key, value]) => [key, normalizeCandidate(value as string)]),
      ),
      candidates,
    };
  } catch (error) {
    return {
      searchedFields: ['identifier', 'label', 'value', 'role'],
      debugError: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectCandidateStrings(node: AXNode): string[] {
  const values = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const raw of [current.identifier, current.label, current.value]) {
      if (!raw) continue;
      const normalized = normalizeCandidate(raw);
      if (normalized) values.add(normalized);
    }
    for (const child of current.children ?? []) {
      stack.push(child);
    }
  }
  return [...values];
}

function normalizeCandidate(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
