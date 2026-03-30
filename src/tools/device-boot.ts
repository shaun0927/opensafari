import { MCPServer, getWebKitClient, setWebKitClient } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSharedProxy } from '../simulator/proxy';
import { WebKitClient } from '../webkit/client';
import { addManagedDevice } from '../reliability/zombie-cleanup';

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

      // Register the booted device in the shared zombie cleanup registry so
      // other MCP sessions' periodic cleanup won't shut it down as an orphan.
      addManagedDevice(device.udid);

      // Auto-start the WebInspector proxy so WebKit debugging is available
      let proxyStatus: { running: boolean; pid: number | null } = { running: false, pid: null };
      try {
        const proxy = getSharedProxy();
        await proxy.start();
        proxyStatus = { running: proxy.running, pid: proxy.pid };

        // Open Safari so it registers with WebInspector, then connect WebKitClient
        try {
          // Disconnect any existing client to avoid leaking WebSocket connections on re-boot
          const existingClient = getWebKitClient();
          if (existingClient) {
            try { await existingClient.disconnect(); } catch { /* best-effort */ }
          }

          // Retry openUrl — the simulator may report "Booted" before app
          // launch services are fully ready (LSApplicationWorkspaceErrorDomain 115).
          let openRetries = 5;
          while (openRetries > 0) {
            try {
              await manager.openUrl(device.udid, 'https://example.com');
              break;
            } catch (openErr) {
              openRetries--;
              if (openRetries === 0) throw openErr;
              await new Promise(r => setTimeout(r, 2000));
            }
          }
          // Connect to WebKit with retries — Safari may need time to register with WebInspector
          const client = new WebKitClient({ host: 'localhost', port: proxy.port });
          await client.connect({ retries: 5, retryDelay: 2000 });
          setWebKitClient(client);
        } catch (err) {
          console.error(`[device_boot] WebKit connection failed (proxy running, tools may not work): ${err}`);
        }
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
