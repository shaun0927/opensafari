import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerScreenshotTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current Safari page',
      inputSchema: {
        type: 'object' as const,
        properties: {
          format: { type: 'string', enum: ['png'], description: 'Image format' },
          fullPage: { type: 'boolean', description: 'Capture full page' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const buffer = await client.screenshot({ format: params.format as 'png' | undefined, fullPage: params.fullPage as boolean | undefined });
      const base64 = buffer.toString('base64');
      return { content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' }] };
    },
  );
}
