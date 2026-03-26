import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerPressTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'press',
      description: 'Press a key in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Key to press (e.g. Enter, Escape, Tab)' },
        },
        required: ['key'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.press(params.key as string);
      return { content: [{ type: 'text' as const, text: 'pressed' }] };
    },
  );
}
