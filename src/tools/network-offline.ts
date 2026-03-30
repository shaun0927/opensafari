import { MCPServer, getWebKitClient } from '../mcp-server';
import { networkInterceptor } from './network-intercept';

export function registerNetworkOfflineTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_offline',
      description: 'Simulate offline mode by blocking all network requests.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          enabled: { type: 'boolean', description: 'true to go offline, false to restore connectivity' },
        },
        required: ['enabled'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const enabled = params.enabled as boolean;
      await networkInterceptor.setOffline(enabled, client);
      return { content: [{ type: 'text' as const, text: enabled ? 'Offline mode enabled' : 'Online mode restored' }] };
    },
  );
}
