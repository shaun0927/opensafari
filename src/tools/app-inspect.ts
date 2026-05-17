import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import { getSessionManager } from '../session-manager';
import {
  activateAndClassify,
  createContextMismatchError,
  NativeContextMeta,
} from './native-app-context';

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

        const node = await bridge.inspect(elementPath, deviceId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...node,
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
