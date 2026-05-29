/**
 * flutter_hot_reload — Trigger hot reload or hot restart on a connected Flutter app.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';

export function registerFlutterHotReloadTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_hot_reload',
      description:
        'Trigger hot reload or hot restart on a connected Flutter app. ' +
        'Hot reload preserves app state; hot restart resets it. ' +
        'Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: ['reload', 'restart'],
            description: 'Reload mode (default: "reload"). "reload" preserves state, "restart" resets state.',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
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
          throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw StructuredErrorException.fromCode(ErrorCode.FLUTTER_VM_NOT_CONNECTED, 'Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        const mode = (params.mode as string | undefined) ?? 'reload';
        const startTime = Date.now();

        let result: Record<string, unknown>;
        if (mode === 'restart') {
          result = await client.hotRestart();
        } else {
          result = await client.hotReload();
        }

        const elapsed = Date.now() - startTime;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: mode === 'restart' ? 'restarted' : 'reloaded',
              mode,
              elapsed,
              deviceId,
              result,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_hot_reload] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message);
      }
    },
  );
}
