import { MCPServer } from '../mcp-server';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';

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
          sessionId: {
            type: 'string',
            description: 'Optional QA session id from qa_session_create. Routes the call to that specific Safari tab.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional simulator UDID. Ignored when sessionId is provided.',
          },
        },
        required: [],
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
      const target = params.selector
        ? (params.selector as string)
        : { x: params.x as number, y: params.y as number };
      await resolved.client.click(target);
      return { content: [{ type: 'text' as const, text: 'clicked' }] };
    },
  );
}
