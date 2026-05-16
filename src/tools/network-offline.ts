import { MCPServer, getWebKitClient } from '../mcp-server';
import { getNetworkInterceptorForSession } from './network-intercept';

export function registerNetworkOfflineTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_offline',
      description: 'Simulate offline mode by blocking all network requests.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          enabled: { type: 'boolean', description: 'true to go offline, false to restore connectivity' },
          device_id: { type: 'string', description: 'Simulator UDID / WebKit connection to target (uses active device if omitted)' },
        },
        required: ['enabled'],
      },
    },
    async (sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient(typeof params.device_id === 'string' ? params.device_id : undefined);
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const enabled = params.enabled as boolean;
      await getNetworkInterceptorForSession(sessionId).setOffline(enabled, client);
      return { content: [{ type: 'text' as const, text: enabled ? 'Offline mode enabled' : 'Online mode restored' }] };
    },
  );
}
