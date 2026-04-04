import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

export function registerAppOpenUrlTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_open_url',
      description:
        'Open a URL on a booted iOS Simulator via deep link, universal link, or custom URL scheme',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description:
              'URL to open (e.g. https://example.com, myapp://path, maps://)',
          },
          deviceId: {
            type: 'string',
            description:
              'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId =
        (params.deviceId as string) ??
        sm.getActiveDeviceId() ??
        booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message:
                  'No booted simulator found. Call device_boot first.',
              }),
            },
          ],
          isError: true,
        };
      }

      const url = params.url as string;

      // Validate URL has a scheme
      const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
      if (!schemeMatch) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'INVALID_URL',
                message: `Invalid URL: "${url}". Must include a scheme (e.g. https://, myapp://)`,
              }),
            },
          ],
          isError: true,
        };
      }

      const scheme = schemeMatch[1];
      await manager.openUrl(deviceId, url);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ opened: true, url, deviceId, scheme }),
          },
        ],
      };
    },
  );
}
