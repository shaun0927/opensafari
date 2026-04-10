import { MCPServer } from '../mcp-server';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';

export function registerPressTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'press',
      description: 'Press a key in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Key to press (e.g. Enter, Escape, Tab)' },
          sessionId: {
            type: 'string',
            description: 'Optional QA session id from qa_session_create. Routes the call to that specific Safari tab.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional simulator UDID. Ignored when sessionId is provided.',
          },
        },
        required: ['key'],
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
      await resolved.client.press(params.key as string);
      return { content: [{ type: 'text' as const, text: 'pressed' }] };
    },
  );
}
