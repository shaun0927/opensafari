/**
 * app_key_input — Send keyboard key events (hardware keyboard simulation).
 *
 * Maps human-readable key names to USB HID key codes and dispatches them
 * via `xcrun simctl io <device> input keypress`.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { resolveDeviceId, getInputBackend, runInputOp, KEY_MAP } from './native-input-utils';
import { ErrorCode, respondWithStructuredError } from '../errors';

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
          return respondWithStructuredError(
            ErrorCode.INVALID_INPUT,
            `Unknown key "${key}". Supported keys: ${Object.keys(KEY_MAP).join(', ')}`,
            { supportedKeys: Object.keys(KEY_MAP) },
          );
        }

        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.keypress(deviceId, keyCode),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'key_pressed',
                key,
                keyCode,
                deviceId,
                backend: backend.kind,
                _meta: meta,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_key_input] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}
