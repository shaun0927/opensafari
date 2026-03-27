import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSharedProxy } from '../simulator/proxy';

export function registerDeviceBootTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_boot',
      description: 'Boot an iOS Simulator device',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device: { type: 'string', description: 'Device name, preset key, or UDID to boot' },
        },
        required: ['device'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const manager = new SimulatorManager();
      const device = await manager.boot(params.device as string);

      // Auto-start the WebInspector proxy so WebKit debugging is available
      let proxyStatus: { running: boolean; pid: number | null } = { running: false, pid: null };
      try {
        const proxy = getSharedProxy();
        await proxy.start();
        proxyStatus = { running: proxy.running, pid: proxy.pid };
      } catch (err) {
        console.error(`[device_boot] Failed to start WebInspector proxy: ${err}`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...device, proxy: proxyStatus }),
        }],
      };
    },
  );
}
