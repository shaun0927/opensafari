import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

export function registerAppLaunchTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_launch',
      description: 'Launch an app by bundle identifier on a booted iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to launch (e.g. com.apple.mobilesafari)',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional launch arguments passed to the app',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional environment variables set in the launched app',
          },
        },
        required: ['bundleId'],
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

      const bundleId = params.bundleId as string;
      const args = params.args as string[] | undefined;
      const env = params.env as Record<string, string> | undefined;

      const result = await manager.launchApp(deviceId, bundleId, { args, env });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );
}
