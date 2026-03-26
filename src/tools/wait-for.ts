import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerWaitForTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'wait_for',
      description: 'Wait for an element to appear in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          visible: { type: 'boolean', description: 'Wait until element is visible' },
          timeout: { type: 'number', description: 'Timeout in milliseconds' },
        },
        required: ['selector'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.waitFor(
        params.selector as string,
        {
          visible: params.visible as boolean | undefined,
          timeout: params.timeout as number | undefined,
        },
      );
      return { content: [{ type: 'text' as const, text: 'element found' }] };
    },
  );
}
