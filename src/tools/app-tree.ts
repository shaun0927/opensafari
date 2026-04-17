import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, FlutterSemanticsUnavailableError } from '../native';
import { getSessionManager } from '../session-manager';

export function registerAppTreeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_tree',
      description: 'Dump the native accessibility tree of the foreground app in iOS Simulator. Returns a structured JSON snapshot of the UI hierarchy including roles, labels, identifiers, traits, frames, and visibility state. Compatible with Flutter apps — the tool auto-activates Flutter\'s lazy Semantics tree before reading so widget labels/text appear as accessibility nodes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator device UDID (defaults to active device)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target Flutter app bundle ID. Used to disambiguate Dart VM Service discovery when multiple Flutter apps run on the same simulator — the macOS AX bridge itself always reads the current foreground app.',
          },
          max_depth: {
            type: 'number',
            description: 'Maximum tree depth to traverse (default: 10)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId() ?? undefined;
        const bundleId = params.bundle_id as string | undefined;
        const maxDepth = params.max_depth as number | undefined;

        const bridge = getAccessibilityBridge();

        // Ensure Flutter semantics are activated before reading the tree.
        // Fall through to AX-only if unavailable (simctl-launched app, release build).
        let semanticsWarning: string | undefined;
        if (deviceId) {
          try {
            await ensureSemanticsActive(deviceId, { bundleId });
          } catch (semErr) {
            if (semErr instanceof FlutterSemanticsUnavailableError) {
              semanticsWarning =
                `Flutter Semantics not available (reason: ${semErr.reason}) — ` +
                'falling back to AX-only tree. Results may be incomplete for Flutter apps.';
              console.error(`[app_tree] ${semanticsWarning}`);
            } else {
              throw semErr;
            }
          }
        }

        const tree = await bridge.dumpTree({ deviceId, maxDepth });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              semanticsWarning ? { semanticsWarning, tree } : tree,
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
