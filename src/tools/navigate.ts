import { MCPServer } from '../mcp-server';
import { assertDomainAllowed } from '../security/domain-guard';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';

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
          sessionId: {
            type: 'string',
            description: 'Optional QA session id from qa_session_create. Routes the call to that specific Safari tab.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional simulator UDID. Ignored when sessionId is provided.',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string;
      assertDomainAllowed(url);

      const resolved = resolveClient(params);
      if (resolved.source === 'none' && resolved.sessionId) {
        return sessionNotFoundError(resolved.sessionId);
      }
      if (!resolved.client) {
        return noClientError();
      }

      const result = await resolved.client.navigate({ url, waitUntil: params.waitUntil as any });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
