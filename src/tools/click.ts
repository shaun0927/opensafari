import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerClickTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'click',
      description: 'Click on an element or coordinates in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to click' },
          x: { type: 'number', description: 'X coordinate to click' },
          y: { type: 'number', description: 'Y coordinate to click' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const target = params.selector
        ? (params.selector as string)
        : { x: params.x as number, y: params.y as number };
      await client.click(target);
      return { content: [{ type: 'text' as const, text: 'clicked' }] };
    },
  );
}
