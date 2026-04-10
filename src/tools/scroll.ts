import { MCPServer } from '../mcp-server';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';

export function registerScrollTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'scroll',
      description: 'Scroll the page in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Amount to scroll in pixels' },
          sessionId: {
            type: 'string',
            description: 'Optional QA session id from qa_session_create. Routes the call to that specific Safari tab.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional simulator UDID. Ignored when sessionId is provided.',
          },
        },
        required: ['direction', 'amount'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const resolved = resolveClient(params);
      if (resolved.source === 'none' && resolved.sessionId) {
        return sessionNotFoundError(resolved.sessionId);
      }
      if (!resolved.client) {
        return noClientError();
      }
      await resolved.client.scroll(
        params.direction as 'up' | 'down' | 'left' | 'right',
        params.amount as number,
      );
      return { content: [{ type: 'text' as const, text: 'scrolled' }] };
    },
  );
}
