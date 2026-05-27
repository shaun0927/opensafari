import { MCPServer } from '../mcp-server';
import { getDefaultSimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError } from '../errors';

export function registerAppTerminateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_terminate',
      description: 'Terminate a running app by bundle identifier on a booted iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to terminate',
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
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found. Call device_boot first.');
      }

      const bundleId = params.bundleId as string;
      const result = await manager.terminateApp(deviceId, bundleId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );
}
