import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, FlutterSemanticsUnavailableError } from '../native';
import { getSessionManager } from '../session-manager';

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

        // Ensure Flutter semantics are activated before querying.
        // If activation fails (simctl-launched app, release build, etc.) we
        // fall through to the AX-only path and attach a warning so the caller
        // knows the Flutter Semantics layer is absent.
        let semanticsWarning: string | undefined;
        if (deviceId) {
          try {
            await ensureSemanticsActive(deviceId, { bundleId });
          } catch (semErr) {
            if (semErr instanceof FlutterSemanticsUnavailableError) {
              semanticsWarning =
                `Flutter Semantics not available (reason: ${semErr.reason}) — ` +
                'falling back to AX-only query. Results may be incomplete for Flutter apps. ' +
                semErr.message;
              console.error(`[app_query] ${semanticsWarning}`);
            } else {
              throw semErr;
            }
          }
        }

        const result = await bridge.query(
          { identifier, label, text, role },
          { deviceId, maxResults },
        );

        if (result.ambiguous) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                warning: `Ambiguous query: identifier "${identifier}" matched ${result.total} elements. Use a more specific query or inspect individual paths.`,
                ...(semanticsWarning ? { semanticsWarning } : {}),
                ...result,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              semanticsWarning ? { semanticsWarning, ...result } : result,
              null, 2,
            ),
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
