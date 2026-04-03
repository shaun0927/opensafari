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
          direction: { type: 'string', enum: ['left', 'right'], description: 'Rotation direction (default: left)' },
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
      const direction = (params.direction as 'left' | 'right') ?? 'left';
      const result = await manager.rotate(deviceId, direction);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ rotated: false, deviceId, method: 'none', error: 'No rotation method available (headless environment?)' }) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ rotated: true, deviceId, method: result.method, orientation: result.orientation }) }] };
    },
  );
}
