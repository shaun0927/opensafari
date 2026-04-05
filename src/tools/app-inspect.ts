import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge } from '../native';
import { getSessionManager } from '../session-manager';

export function registerAppInspectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_inspect',
      description: 'Inspect a specific native UI element by its index path (from app_tree or app_query results). Returns detailed metadata including role, label, value, identifier, traits, frame, visibility, enabled, and focused state.',
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
        const deviceId = (params.device_id as string) ?? getSessionManager().getActiveDeviceId() ?? undefined;

        const bridge = getAccessibilityBridge();
        const node = await bridge.inspect(elementPath, deviceId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(node, null, 2),
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
