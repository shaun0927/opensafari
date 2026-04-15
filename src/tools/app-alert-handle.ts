import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-backend';
import { runInputOp } from './native-input-utils';

export function registerAppAlertHandleTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_alert_handle',
      description:
        'Accept or dismiss a system alert/dialog on a booted iOS Simulator. ' +
        'Uses keyboard input (Return to accept, Escape to dismiss) with an AppleScript fallback.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['accept', 'dismiss'],
            description: 'Whether to accept or dismiss the alert',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId =
        (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message: 'No booted simulator found. Call device_boot first.',
              }),
            },
          ],
          isError: true,
        };
      }

      const action = params.action as string;

      if (action !== 'accept' && action !== 'dismiss') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'INVALID_ACTION',
                message: `Invalid action "${action}". Must be "accept" or "dismiss".`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Use the input backend to send the appropriate key
      // Return/Enter accepts alerts, Escape dismisses them
      const keyName = action === 'accept' ? 'Return' : 'Escape';

      try {
        const backend = await getInputBackend(deviceId);
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.sendKey(deviceId, keyName),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                handled: true,
                action,
                deviceId,
                method: 'input_backend',
                _meta: meta,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'ALERT_HANDLE_FAILED',
                message: `Failed to ${action} alert: ${message}. No visible alert may be present.`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
