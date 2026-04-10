import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { SimctlExecutor } from '../simulator/simctl';
import { getSharedProxy } from '../simulator/proxy';
import { WebKitClient } from '../webkit/client';
import { addManagedDevice } from '../reliability/zombie-cleanup';
import { getSessionManager } from '../session-manager';
import { DEVICE_PRESETS } from '../simulator/presets';
import { disableBackgroundServices } from '../simulator/post-boot-optimize';
import { DEFAULT_MAX_SIMULATORS } from '../config/defaults';

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

      // Enforce max-simulator concurrency limit before attempting boot
      const maxSims = parseInt(process.env.OPENSAFARI_MAX_SIMULATORS ?? '', 10) || DEFAULT_MAX_SIMULATORS;
      const booted = await manager.listBooted();
      const alreadyBooted = booted.some(
        (d) => d.name === (params.device as string) || d.udid === (params.device as string),
      );
      if (!alreadyBooted && booted.length >= maxSims) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'MAX_SIMULATORS_REACHED',
              message: `Cannot boot another simulator: ${booted.length}/${maxSims} already running. ` +
                `Set OPENSAFARI_MAX_SIMULATORS to increase the limit, or shut down an existing device.`,
              running: booted.map((d) => ({ udid: d.udid, name: d.name })),
            }),
          }],
          isError: true,
        };
      }

      const device = await manager.boot(params.device as string);

      // Register the booted device in the shared zombie cleanup registry so
      // other MCP sessions' periodic cleanup won't shut it down as an orphan.
      addManagedDevice(device.udid);

      // Disable unnecessary background services to reduce RAM usage (~400-800 MB savings)
      try {
        const simctl = new SimctlExecutor();
        await disableBackgroundServices(simctl, device.udid);
      } catch (err) {
        console.error(`[device_boot] Post-boot optimization failed (non-fatal): ${err}`);
      }

      // Auto-start the WebInspector proxy so WebKit debugging is available
      let proxyStatus: { running: boolean; pid: number | null } = { running: false, pid: null };
      try {
        const proxy = getSharedProxy();
        await proxy.start();
        proxyStatus = { running: proxy.running, pid: proxy.pid };

        // Open Safari so it registers with WebInspector, then connect WebKitClient
        try {
          const sm = getSessionManager();

          // Disconnect any existing client for THIS device to avoid leaking WebSocket connections
          if (sm.hasConnection(device.udid)) {
            const existingClient = sm.getConnection(device.udid);
            if (existingClient) {
              try { await existingClient.disconnect(); } catch { /* best-effort */ }
            }
            sm.removeConnection(device.udid);
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

          // Register in SessionManager — tracks connection and sets as active device
          const preset = Object.entries(DEVICE_PRESETS).find(([, p]) => p.name === device.name);
          sm.addSimulator(device.udid, {
            deviceId: device.udid,
            deviceType: device.name,
            state: 'booted',
            viewport: { width: preset?.[1]?.w ?? 390, height: preset?.[1]?.h ?? 844 },
            bootedAt: Date.now(),
            lastActivity: Date.now(),
          });
          sm.setConnection(device.udid, client);
          sm.setActiveDevice(device.udid);
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
