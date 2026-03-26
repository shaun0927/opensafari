import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerTypeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'type',
      description: 'Type text into an element in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to type into' },
          text: { type: 'string', description: 'Text to type' },
          delay: { type: 'number', description: 'Delay between keystrokes in ms' },
        },
        required: ['selector', 'text'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.type(
        params.selector as string,
        params.text as string,
        params.delay !== undefined ? { delay: params.delay as number } : undefined,
      );
      return { content: [{ type: 'text' as const, text: 'typed' }] };
    },
  );
}
