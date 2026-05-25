import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { DEVICE_PRESETS } from '../simulator/presets';
import { getInputBackend } from './native-input-backend';
import { runInputOp } from './native-input-utils';

/**
 * PR24: compute a safe defocus tap coordinate from the device preset
 * instead of the pre-PR24 hard-coded (195, 50) which only hit the
 * status bar on compact iPhones. We tap at 50 % width, 8 % height —
 * under the status bar / Dynamic Island but above any input affordance
 * on every preset we ship.
 */
async function computeDefocusTap(
  deviceId: string,
  manager: SimulatorManager,
): Promise<{ x: number; y: number; source: 'preset' | 'fallback' }> {
  try {
    const booted = await manager.listBooted();
    const device = booted.find((d) => d.udid === deviceId);
    if (device) {
      const preset = Object.values(DEVICE_PRESETS).find((p) => p.name === device.name);
      if (preset) {
        return {
          x: Math.round(preset.w * 0.5),
          y: Math.round(preset.h * 0.08),
          source: 'preset',
        };
      }
    }
  } catch {
    // listBooted failed — fall through to the historical default
  }
  return { x: 195, y: 50, source: 'fallback' };
}

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

      // Fallback: tap on the status-bar area to defocus text fields. The
      // coordinate is derived from the device preset (PR24) so iPad and
      // landscape sims don't end up tapping outside the frame.
      const defocus = await computeDefocusTap(deviceId, manager);
      try {
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.tap(deviceId, defocus.x, defocus.y),
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dismissed: true,
              deviceId,
              method: 'tap_fallback',
              tapCoord: { x: defocus.x, y: defocus.y, source: defocus.source },
              _meta: meta,
            }),
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
