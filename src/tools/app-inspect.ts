import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, FlutterSemanticsUnavailableError } from '../native';
import { getSessionManager } from '../session-manager';

export function registerAppInspectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_inspect',
      description: 'Inspect a specific native UI element by its index path (from app_tree or app_query results). Returns detailed metadata including role, label, value, identifier, traits, frame, visibility, enabled, and focused state. Compatible with Flutter apps — the tool auto-activates Flutter\'s lazy Semantics tree before inspection.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Element index path from app_tree/app_query results (e.g. "0/2/1")',
          },
          device_id: {
            type: 'string',
            description: 'Simulator device UDID (defaults to active device)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target Flutter app bundle ID. Used to disambiguate Dart VM Service discovery when multiple Flutter apps run on the same simulator.',
          },
        },
        required: ['path'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const elementPath = params.path as string;
      if (!elementPath && elementPath !== '') {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: path parameter is required',
          }],
          isError: true,
        };
      }

      try {
        const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId() ?? undefined;
        const bundleId = params.bundle_id as string | undefined;

        const bridge = getAccessibilityBridge();

        // Ensure Flutter semantics are activated before inspecting.
        // Fall through to AX-only if unavailable (simctl-launched app, release build).
        let semanticsWarning: string | undefined;
        if (deviceId) {
          try {
            await ensureSemanticsActive(deviceId, { bundleId });
          } catch (semErr) {
            if (semErr instanceof FlutterSemanticsUnavailableError) {
              semanticsWarning =
                `Flutter Semantics not available (reason: ${semErr.reason}) — ` +
                'falling back to AX-only inspect. Results may be incomplete for Flutter apps.';
              console.error(`[app_inspect] ${semanticsWarning}`);
            } else {
              throw semErr;
            }
          }
        }

        const node = await bridge.inspect(elementPath, deviceId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              semanticsWarning ? { semanticsWarning, ...node } : node,
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
