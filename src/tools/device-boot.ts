import { MCPServer } from '../mcp-server';
import { getDefaultSimulatorManager } from '../simulator';
import { SimctlExecutor } from '../simulator/simctl';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { getProxyForDevice, stopProxyForDevice, peekProxyForDevice } from '../simulator/proxy-manager';
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
      const manager = getDefaultSimulatorManager();

      // Enforce max-simulator concurrency limit before attempting boot
      const maxSims = parseInt(process.env.OPENSAFARI_MAX_SIMULATORS ?? '', 10) || DEFAULT_MAX_SIMULATORS;
      const booted = await manager.listBooted();
      const target = params.device as string;
      const alreadyBootedDevice = booted.find(
        (d) => d.name === target || d.udid === target,
      );
      const alreadyBooted = Boolean(alreadyBootedDevice);

      // Fast path: device is already booted AND we still have a healthy
      // WebKitClient + proxy for it from a prior call. Skip the entire
      // boot/openSafari/connectWebKit sequence — repeating it tears down
      // an otherwise-good WebSocket and races against any Flutter VM
      // service that's still using the proxy. Without this, every
      // `device_boot` call paid a ~2-5 s tax on already-healthy sims.
      if (alreadyBootedDevice) {
        const sm = getSessionManager();
        const existingClient = sm.getConnection(alreadyBootedDevice.udid);
        const existingProxy = peekProxyForDevice(alreadyBootedDevice.udid);
        if (existingClient && existingClient.isConnected() && existingProxy?.running) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                udid: alreadyBootedDevice.udid,
                name: alreadyBootedDevice.name,
                state: alreadyBootedDevice.state,
                alreadyBootedAndHealthy: true,
                proxy: {
                  running: existingProxy.running,
                  pid: existingProxy.pid,
                  port: existingProxy.port,
                },
              }),
            }],
          };
        }
      }

      if (!alreadyBooted && booted.length >= maxSims) {
        return respondWithStructuredError(
          ErrorCode.RESOURCE_EXHAUSTED,
          `Cannot boot another simulator: ${booted.length}/${maxSims} already running. Set OPENSAFARI_MAX_SIMULATORS to increase the limit, or shut down an existing device.`,
          { running: booted.map((d) => ({ udid: d.udid, name: d.name })) },
        );
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

      const sm = getSessionManager();
      const preset = Object.entries(DEVICE_PRESETS).find(([, p]) => p.name === device.name);

      // Register the simulator even if WebKit target discovery fails. Native
      // tools and diagnostics can still operate on a successfully booted
      // simulator; only Safari/WebKit tools should remain unavailable.
      sm.addSimulator(device.udid, {
        deviceId: device.udid,
        deviceType: device.name,
        state: 'booted',
        viewport: { width: preset?.[1]?.w ?? 390, height: preset?.[1]?.h ?? 844 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });

      // Auto-start a per-device WebInspector proxy so parallel sessions
      // each get their own isolated proxy bound to their simulator's socket.
      let proxyStatus: { running: boolean; pid: number | null; port: number | null } = {
        running: false,
        pid: null,
        port: null,
      };

      const openSafariWithRetry = async (): Promise<void> => {
        // Retry openUrl — the simulator may report "Booted" before app
        // launch services are fully ready (LSApplicationWorkspaceErrorDomain 115).
        let openRetries = 5;
        while (openRetries > 0) {
          try {
            await manager.openUrl(device.udid, 'https://example.com');
            return;
          } catch (openErr) {
            openRetries--;
            if (openRetries === 0) throw openErr;
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      };

      const connectWebKit = async (port: number): Promise<WebKitClient> => {
        // Disconnect any existing client for THIS device to avoid leaking WebSocket connections.
        const existingClient = sm.getConnection(device.udid);
        if (existingClient) {
          try { await existingClient.disconnect(); } catch { /* best-effort */ }
          sm.removeConnection(device.udid);
        }

        await openSafariWithRetry();
        const client = new WebKitClient({ host: 'localhost', port });
        await client.connect({ retries: 5, retryDelay: 2000 });
        sm.setConnection(device.udid, client);
        return client;
      };

      try {
        let proxy = await getProxyForDevice(device.udid);
        proxyStatus = { running: proxy.running, pid: proxy.pid, port: proxy.port };

        try {
          // Give slow Safari registrations a short window to appear before the first
          // connect attempt. Falls through tolerantly so fast paths stay fast.
          await proxy.waitForTarget({ timeout: 3000 }).catch(() => { /* tolerated */ });
          await connectWebKit(proxy.port);
        } catch (err) {
          console.error(`[device_boot] WebKit connection failed; restarting device proxy once: ${err}`);
          await stopProxyForDevice(device.udid).catch((stopErr) => {
            console.error(`[device_boot] Failed to stop stale WebInspector proxy: ${stopErr}`);
          });
          proxy = await getProxyForDevice(device.udid);
          proxyStatus = { running: proxy.running, pid: proxy.pid, port: proxy.port };
          await proxy.waitForTarget({ timeout: 3000 }).catch(() => { /* tolerated */ });
          await connectWebKit(proxy.port);
        }
      } catch (err) {
        // Keep the booted simulator registered for native-tool fallback, but
        // make the missing WebKit connection visible through diagnose/QA tools.
        console.error(`[device_boot] WebKit connection failed (proxy unavailable, Safari tools may not work): ${err}`);
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
