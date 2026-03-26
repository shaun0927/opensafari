import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerQueryDomTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'query_dom',
      description: 'Query DOM elements in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector to query' },
        },
        required: ['selector'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const results = await client.querySelectorAll(params.selector as string);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
    },
  );
}
