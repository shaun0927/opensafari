import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerSwipeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'swipe',
      description: 'Swipe gesture in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Swipe direction' },
          speed: { type: 'number', description: 'Swipe speed' },
        },
        required: ['direction'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.swipe(
        params.direction as 'up' | 'down' | 'left' | 'right',
        params.speed as number | undefined,
      );
      return { content: [{ type: 'text' as const, text: 'swiped' }] };
    },
  );
}
