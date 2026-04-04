import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-utils';

export function registerAppOpenUrlTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_open_url',
      description:
        'Open a URL or deep link on an iOS Simulator. Routes to the appropriate app handler (e.g. Safari for https://, or a custom scheme like myapp://).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'URL or deep link to open (e.g. myapp://path, https://example.com)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const url = params.url as string;

        if (!url) {
          throw new Error('url parameter is required');
        }

        const simctl = new SimctlExecutor();
        await simctl.exec(['openurl', deviceId, url]);

        const result = {
          url,
          deviceId,
          openedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_open_url] Error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
