import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerSelectOptionTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'select_option',
      description: 'Select an option from a dropdown in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of the select element' },
          value: { type: 'string', description: 'Value to select' },
        },
        required: ['selector', 'value'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.selectOption(params.selector as string, params.value as string);
      return { content: [{ type: 'text' as const, text: 'option selected' }] };
    },
  );
}
