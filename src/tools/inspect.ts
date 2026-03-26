import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerInspectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'inspect',
      description: 'Inspect a DOM element in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to inspect' },
        },
        required: ['selector'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const result = await client.inspect(params.selector as string);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
