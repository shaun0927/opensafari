import { MCPServer, getWebKitClient } from '../mcp-server';
import { assertDomainAllowed } from '../security/domain-guard';

export function registerNavigateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'navigate',
      description: 'Navigate to a URL in real Safari on iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          waitUntil: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: 'Wait strategy',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string;
      assertDomainAllowed(url);
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const result = await client.navigate({ url, waitUntil: params.waitUntil as any });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
