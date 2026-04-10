import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSharedProxy } from '../simulator/proxy';
import { getSessionManager } from '../session-manager';
import { disposeDevice } from './tab-manager';

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
      const sm = getSessionManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;
      if (!deviceId) {
        return { content: [{ type: 'text' as const, text: 'Error: no booted device found' }], isError: true };
      }

      // Close any active tab sessions for this device before tearing down
      // the underlying WebKitClient (#408 Phase 2A)
      try {
        await disposeDevice(deviceId);
      } catch (err) {
        console.error(`[device_shutdown] Tab session cleanup failed: ${err}`);
      }

      // Disconnect and remove the WebKitClient via SessionManager
      if (sm.hasConnection(deviceId)) {
        const client = sm.getConnection(deviceId);
        if (client) {
          try {
            await client.disconnect();
          } catch (err) {
            console.error(`[device_shutdown] WebKit disconnect failed: ${err}`);
          }
        }
      }
      // Remove simulator from SessionManager (also clears connection, updates active device)
      sm.removeSimulator(deviceId);

      // Stop the WebInspector proxy if no more connections remain
      const proxy = getSharedProxy();
      let proxyStopped = false;
      if (proxy.running && sm.listConnections().length === 0) {
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
