import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';

export function registerAppPushTool(server: MCPServer): void {
  const simctl = new SimctlExecutor();

  server.registerTool(
    {
      name: 'app_push',
      description: 'Inject a push notification into a booted iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier to receive the notification',
          },
          payload: {
            type: 'object',
            description: 'APNS payload object (e.g. { "aps": { "alert": "Hello" } })',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['bundleId', 'payload'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const payload = params.payload as Record<string, unknown>;

      if (!payload || typeof payload !== 'object') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_PAYLOAD', message: 'Payload must be a JSON object with APNS structure' }) }],
          isError: true,
        };
      }

      // Write payload to temp file
      const tmpFile = path.join(os.tmpdir(), `opensafari-push-${randomUUID()}.json`);

      try {
        await fs.writeFile(tmpFile, JSON.stringify(payload), 'utf-8');
        await simctl.exec(['push', deviceId, bundleId, tmpFile]);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ pushed: true, bundleId, deviceId }),
          }],
        };
      } finally {
        // Clean up temp file
        await fs.unlink(tmpFile).catch(() => {});
      }
    },
  );
}
