import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { getInputBackend } from './native-input-backend';
import { runInputOp } from './native-input-utils';

export function registerAppDismissKeyboardTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_dismiss_keyboard',
      description: 'Dismiss the software keyboard in any native iOS app on the Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Simulator UDID (optional, defaults to active device)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const manager = new SimulatorManager();

      // Resolve device ID: explicit param → session active → first booted
      const deviceId =
        (params.deviceId as string) ??
        getSessionManager().getSoleDeviceId() ??
        (await manager.listBooted())[0]?.udid;

      if (!deviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'No booted simulator found', code: 'DEVICE_NOT_BOOTED' }),
          }],
          isError: true,
        };
      }

      const backend = await getInputBackend(deviceId);

      // Primary method: send Escape key to dismiss keyboard
      try {
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.sendKey(deviceId, 'Escape'),
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ dismissed: true, deviceId, method: 'sendkey', _meta: meta }),
          }],
        };
      } catch (err) {
        console.error(`[app_dismiss_keyboard] sendkey failed: ${err}`);
      }

      // Fallback: tap on status bar area to defocus text fields
      try {
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.tap(deviceId, 195, 50),
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ dismissed: true, deviceId, method: 'tap_fallback', _meta: meta }),
          }],
        };
      } catch (err) {
        console.error(`[app_dismiss_keyboard] tap fallback failed: ${err}`);
      }

      // Both methods failed
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Failed to dismiss keyboard', code: 'KEYBOARD_DISMISS_FAILED', deviceId }),
        }],
        isError: true,
      };
    },
  );
}
