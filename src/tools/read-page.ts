import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerReadPageTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'read_page',
      description: 'Read the current page content from Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async (_sessionId: string, _params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const result = await client.readPage();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
