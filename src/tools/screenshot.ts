import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { resolveClient, sessionNotFoundError, noClientError } from './client-resolver';
import { ErrorCode, respondWithStructuredError } from '../errors';

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
      const client = resolved.client;
      if (!client) {
        return noClientError();
      }

      // Try WebKit protocol screenshot first, fall back to simctl
      let buffer: Buffer;
      try {
        buffer = await client.screenshot({
          format: params.format as 'png' | undefined,
          fullPage: params.fullPage as boolean | undefined,
        });
      } catch {
        // Fallback: use simctl io screenshot
        const manager = new SimulatorManager();
        const booted = await manager.listBooted();
        if (booted.length === 0) {
          return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator for screenshot fallback');
        }
        buffer = await manager.screenshot(booted[0].udid);
      }

      const base64 = buffer.toString('base64');
      return { content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' }] };
    },
  );
}
