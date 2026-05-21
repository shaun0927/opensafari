import { MCPServer } from '../mcp-server';
import { getDefaultSimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

export function registerAppResetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_reset',
      description:
        'Reset app state on a booted iOS Simulator. Terminates the app, resets privacy permissions, ' +
        'and uninstalls it to clear all data. The app must be reinstalled after reset.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to reset',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = getDefaultSimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const result = await manager.resetApp(deviceId, bundleId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );
}
