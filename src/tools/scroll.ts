import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerScrollTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'scroll',
      description: 'Scroll the page in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Amount to scroll in pixels' },
        },
        required: ['direction', 'amount'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.scroll(
        params.direction as 'up' | 'down' | 'left' | 'right',
        params.amount as number,
      );
      return { content: [{ type: 'text' as const, text: 'scrolled' }] };
    },
  );
}
