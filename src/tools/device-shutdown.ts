import { MCPServer, getWebKitClient, setWebKitClient } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSharedProxy } from '../simulator/proxy';

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

      // Disconnect and clear the WebKitClient before shutting down
      const client = getWebKitClient();
      if (client) {
        try {
          await client.disconnect();
        } catch (err) {
          console.error(`[device_shutdown] WebKit disconnect failed: ${err}`);
        }
      }
      setWebKitClient(null);

      // Stop the WebInspector proxy if we own it
      const proxy = getSharedProxy();
      let proxyStopped = false;
      if (proxy.running) {
        try {
          await proxy.stop();
          proxyStopped = true;
        } catch (err) {
          console.error(`[device_shutdown] Failed to stop proxy: ${err}`);
        }
      }

      await manager.shutdown(deviceId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ shutdown: true, deviceId, proxyStopped }),
        }],
      };
    },
  );
}
