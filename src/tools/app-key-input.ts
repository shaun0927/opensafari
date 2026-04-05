/**
 * app_key_input — Send keyboard key events (hardware keyboard simulation).
 *
 * Maps human-readable key names to USB HID key codes and dispatches them
 * via `xcrun simctl io <device> input keypress`.
 */

import { MCPServer } from '../mcp-server';
import { resolveDeviceId, getInputBackend, KEY_MAP } from './native-input-utils';

export function registerAppKeyInputTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_key_input',
      description:
        'Send a keyboard key press to the iOS Simulator (e.g. return, escape, tab, arrow keys)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          key: {
            type: 'string',
            description: `Key to press. Supported: ${Object.keys(KEY_MAP).join(', ')}`,
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['key'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const key = (params.key as string).toLowerCase();

        const keyCode = KEY_MAP[key];
        if (!keyCode) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Unknown key "${key}". Supported keys: ${Object.keys(KEY_MAP).join(', ')}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const backend = await getInputBackend(deviceId);
        await backend.keypress(deviceId, keyCode);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'key_pressed',
                key,
                keyCode,
                deviceId,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_key_input] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
