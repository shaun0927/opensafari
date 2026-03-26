import { MCPServer, getWebKitClient } from '../mcp-server';
import { Cookie } from '../types/browser-backend';

export function registerCookiesTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'cookies',
      description: 'Get, set, or clear cookies in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Cookie action' },
          cookies: { type: 'array', description: 'Cookies to set (for action=set)' },
          domain: { type: 'string', description: 'Domain to filter cookies (for action=get)' },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };

      const action = params.action as 'get' | 'set' | 'clear';

      if (action === 'get') {
        const cookies = await client.getCookies(params.domain as string | undefined);
        return { content: [{ type: 'text' as const, text: JSON.stringify(cookies) }] };
      } else if (action === 'set') {
        await client.setCookies((params.cookies as Cookie[]) ?? []);
        return { content: [{ type: 'text' as const, text: 'cookies set' }] };
      } else {
        await client.clearCookies();
        return { content: [{ type: 'text' as const, text: 'cookies cleared' }] };
      }
    },
  );
}
