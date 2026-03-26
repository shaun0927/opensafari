import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerJavascriptTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'javascript',
      description: 'Execute JavaScript in the current Safari page',
      inputSchema: {
        type: 'object' as const,
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        },
        required: ['expression'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const result = await client.evaluate(params.expression as string);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
