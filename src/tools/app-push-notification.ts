import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-helpers';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface APNsPayload {
  aps: {
    alert?: {
      title?: string;
      body?: string;
    };
    badge?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Build APNs payload from tool params.
 * If a custom payload object is provided it is used as-is;
 * otherwise a payload is constructed from title / body / badge.
 */
export function buildAPNsPayload(params: Record<string, unknown>): APNsPayload {
  if (params.payload && typeof params.payload === 'object') {
    return params.payload as APNsPayload;
  }

  const title = (params.title as string) || 'Test Notification';
  const body = (params.body as string) || '';
  const badge = params.badge as number | undefined;

  const payload: APNsPayload = {
    aps: {
      alert: { title, body },
      ...(badge !== undefined && { badge }),
    },
  };

  return payload;
}

export function registerAppPushNotificationTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_push_notification',
      description:
        'Inject a push notification into a simulator app. Build a notification from title/body/badge or provide a full custom APNs payload.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'Target app bundle identifier',
          },
          title: {
            type: 'string',
            description: 'Notification title',
          },
          body: {
            type: 'string',
            description: 'Notification body text',
          },
          badge: {
            type: 'number',
            description: 'Badge count',
          },
          payload: {
            type: 'object',
            description: 'Custom APNs payload (overrides title/body/badge if provided)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const bundleId = params.bundleId as string;

      if (!bundleId) {
        return {
          content: [{ type: 'text' as const, text: 'Error: bundleId is required' }],
          isError: true,
        };
      }

      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const apsPayload = buildAPNsPayload(params);
      const tmpFile = join(tmpdir(), `opensafari-apns-${randomUUID()}.json`);

      try {
        await writeFile(tmpFile, JSON.stringify(apsPayload), 'utf-8');

        const simctl = new SimctlExecutor();
        await simctl.exec(['push', deviceId, bundleId, tmpFile]);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                bundleId,
                deviceId,
                payload: apsPayload,
                sentAt: new Date().toISOString(),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: failed to send push notification to ${bundleId}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      } finally {
        try {
          await unlink(tmpFile);
        } catch {
          // Best effort cleanup
        }
      }
    },
  );
}
