/**
 * app_type_text — Type text into the currently focused native text field.
 *
 * Uses `xcrun simctl io <device> input text` which sends keyboard input
 * to whatever field currently has focus in the foreground app.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { resolveDeviceId, getInputBackend } from './native-input-utils';

export function registerAppTypeTextTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_type_text',
      description:
        'Type text into the focused field in the iOS Simulator (works with any app)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Text to type into the focused field',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['text'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const text = params.text as string;

        if (typeof text !== 'string' || text.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'text must be a non-empty string' }),
              },
            ],
            isError: true,
          };
        }

        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        await backend.typeText(deviceId, text);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'typed',
                length: text.length,
                deviceId,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_type_text] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
