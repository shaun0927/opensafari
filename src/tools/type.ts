import { MCPServer } from '../mcp-server';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';

export function registerTypeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'type',
      description: 'Type text into an element in Safari',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to type into' },
          text: { type: 'string', description: 'Text to type' },
          delay: { type: 'number', description: 'Delay between keystrokes in ms' },
          sessionId: {
            type: 'string',
            description: 'Optional QA session id from qa_session_create. Routes the call to that specific Safari tab.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional simulator UDID. Ignored when sessionId is provided.',
          },
        },
        required: ['selector', 'text'],
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
      await resolved.client.type(
        params.selector as string,
        params.text as string,
        params.delay !== undefined ? { delay: params.delay as number } : undefined,
      );
      return { content: [{ type: 'text' as const, text: 'typed' }] };
    },
  );
}
