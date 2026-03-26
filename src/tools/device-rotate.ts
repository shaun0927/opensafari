import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';

export function registerDeviceRotateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_rotate',
      description: 'Rotate an iOS Simulator device',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UDID to rotate' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? booted[0]?.udid;
      if (!deviceId) {
        return { content: [{ type: 'text' as const, text: 'Error: no booted device found' }], isError: true };
      }
      await manager.rotate(deviceId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ rotated: true, deviceId }) }] };
    },
  );
}
