import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';

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
      const simctl = manager.getSimctl();

      // Resolve device ID: explicit param → session active → first booted
      const deviceId =
        (params.deviceId as string) ??
        getSessionManager().getActiveDeviceId() ??
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

      // Primary method: send Escape key to dismiss keyboard
      try {
        await simctl.exec(['io', deviceId, 'sendkey', 'Escape'], { timeout: 5000 });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ dismissed: true, deviceId, method: 'sendkey' }),
          }],
        };
      } catch (err) {
        console.error(`[app_dismiss_keyboard] sendkey failed: ${err}`);
      }

      // Fallback: tap on status bar area to defocus text fields
      try {
        await simctl.exec(['io', deviceId, 'input', 'tap', '195', '50'], { timeout: 5000 });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ dismissed: true, deviceId, method: 'tap_fallback' }),
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
