import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';

export function registerAppearanceToggleTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'appearance_toggle',
      description: 'Toggle light/dark appearance on an iOS Simulator device',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UDID' },
          mode: { type: 'string', enum: ['light', 'dark'], description: 'Appearance mode to set' },
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
      let result: 'light' | 'dark';
      if (params.mode) {
        await manager.setAppearance(deviceId, params.mode as 'light' | 'dark');
        result = params.mode as 'light' | 'dark';
      } else {
        result = await manager.toggleAppearance(deviceId);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ appearance: result, deviceId }) }] };
    },
  );
}
