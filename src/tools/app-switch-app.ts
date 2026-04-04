import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

export function registerAppSwitchAppTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_switch_app',
      description: 'Switch to (foreground) an app on a booted iOS Simulator, optionally opening a URL for handoff flows',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier to switch to (e.g. com.apple.mobilesafari)',
          },
          url: {
            type: 'string',
            description: 'Optional URL to open when switching (for deep-link or handoff flows)',
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
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getActiveDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const url = params.url as string | undefined;

      if (url) {
        // Open URL — the OS routes it to the appropriate app
        await manager.openUrl(deviceId, url);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ switched: true, bundleId, deviceId, url }),
          }],
        };
      }

      // Launch/foreground the app by bundle ID
      const result = await manager.launchApp(deviceId, bundleId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ switched: true, bundleId, deviceId, pid: result.pid }),
        }],
      };
    },
  );
}
