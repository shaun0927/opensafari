/**
 * flutter_connect — Connect to a Flutter app's Dart VM Service.
 *
 * Auto-discovers the VM Service URL from simulator logs, or accepts
 * an explicit URL. Required before using other flutter_* tools.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

export function registerFlutterConnectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_connect',
      description:
        'Connect to a Flutter app\'s Dart VM Service for debug inspection. ' +
        'Auto-discovers the observatory URL from simulator logs, or accepts an explicit URL. ' +
        'Required before using flutter_widget_tree, flutter_hot_reload, flutter_logs, etc. ' +
        'Only works with debug/profile builds (release builds disable VM Service).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          vm_service_url: {
            type: 'string',
            description: 'Explicit VM Service URL (e.g. "http://127.0.0.1:50642/abc=/"). If omitted, auto-discovers from logs.',
          },
          bundle_id: {
            type: 'string',
            description: 'Bundle ID of the Flutter app (helps disambiguate if multiple apps running)',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          timeout: {
            type: 'number',
            description: 'Discovery timeout in ms (default: 10000)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device. Boot a simulator first.');
        }

        const client = getFlutterVMClient(deviceId);

        // Disconnect existing connection if any
        if (client.isConnected()) {
          await client.disconnect();
        }

        const state = await client.connect({
          deviceId,
          vmServiceUrl: params.vm_service_url as string | undefined,
          bundleId: params.bundle_id as string | undefined,
          timeout: params.timeout as number | undefined,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'connected',
              vmServiceUrl: state.httpUrl,
              wsUrl: state.wsUrl,
              deviceId: state.deviceId,
              vm: state.vmInfo ? {
                name: state.vmInfo.name,
                version: state.vmInfo.version,
                pid: state.vmInfo.pid,
                isolates: state.vmInfo.isolates.map((i) => ({ id: i.id, name: i.name })),
              } : null,
              mainIsolateId: state.mainIsolateId,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_connect] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
