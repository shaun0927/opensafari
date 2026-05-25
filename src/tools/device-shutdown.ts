import { MCPServer } from '../mcp-server';
import { getDefaultSimulatorManager } from '../simulator';
import { stopProxyForDevice } from '../simulator/proxy-manager';
import { getSessionManager } from '../session-manager';
import { disposeDevice } from './tab-manager';
import { removeFlutterVMClient } from '../flutter';
import { forgetVMServiceUrl } from '../flutter/vm-service-discovery';

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
      const manager = getDefaultSimulatorManager();
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
      // Tear down any Flutter VM Service client for this device. Without
      // this, the singleton in `flutter/vm-service-client.ts` keeps stale
      // `state` (connected=false plus an outdated mainIsolateId) that the
      // next `flutter_connect` against the same UDID would inherit.
      try {
        removeFlutterVMClient(deviceId);
        forgetVMServiceUrl(deviceId);
      } catch (err) {
        console.error(`[device_shutdown] Flutter VM client cleanup failed: ${err}`);
      }

      // Remove simulator from SessionManager (also clears connection, updates active device)
      sm.removeSimulator(deviceId);

      // Stop this device's dedicated WebInspector proxy (other devices'
      // proxies are untouched). #408 Phase 2B.1
      let proxyStopped = false;
      try {
        await stopProxyForDevice(deviceId);
        proxyStopped = true;
      } catch (err) {
        console.error(`[device_shutdown] Failed to stop proxy for ${deviceId}: ${err}`);
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
