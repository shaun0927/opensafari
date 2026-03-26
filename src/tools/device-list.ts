import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';

export function registerDeviceListTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_list',
      description: 'List available iOS Simulator devices',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async (_sessionId: string, _params: Record<string, unknown>) => {
      const manager = new SimulatorManager();
      const devices = await manager.listDevices();
      return { content: [{ type: 'text' as const, text: JSON.stringify(devices) }] };
    },
  );
}
