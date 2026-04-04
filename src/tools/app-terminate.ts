import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-utils';

export function registerAppTerminateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_terminate',
      description: 'Terminate a running native app by bundle ID on an iOS Simulator.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const bundleId = params.bundleId as string;

        const simctl = new SimctlExecutor();

        try {
          await simctl.exec(['terminate', deviceId, bundleId]);
        } catch (err) {
          // Gracefully handle the case where the app is not running
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('not running') || message.includes('failed to terminate')) {
            console.error(`[app_terminate] App ${bundleId} was not running, treating as success`);
          } else {
            throw err;
          }
        }

        const result = {
          bundleId,
          deviceId,
          terminatedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_terminate] Error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
