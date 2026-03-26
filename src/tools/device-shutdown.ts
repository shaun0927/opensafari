import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';

export function registerDeviceShutdownTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_shutdown',
      description: 'Shutdown an iOS Simulator device',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UDID to shutdown' },
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
      await manager.shutdown(deviceId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ shutdown: true, deviceId }) }] };
    },
  );
}
