import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

export function registerAppListRunningTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_list_running',
      description: 'List running foreground apps on a booted iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const apps = await manager.listRunningApps(deviceId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ deviceId, apps, count: apps.length }),
        }],
      };
    },
  );
}
