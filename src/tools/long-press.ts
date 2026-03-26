import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerLongPressTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'long_press',
      description: 'Long press on an element in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to long press' },
          duration: { type: 'number', description: 'Press duration in milliseconds' },
        },
        required: ['selector'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.longPress(params.selector as string, params.duration as number | undefined);
      return { content: [{ type: 'text' as const, text: 'long pressed' }] };
    },
  );
}
