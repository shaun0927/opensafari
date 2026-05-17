import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-helpers';
import {
  captureLogsWindow,
  type CaptureLogsOptions,
} from '../observability/capture-logs-window';

export function registerAppDeeplinkTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_deeplink',
      description:
        'Open deep links or universal links in the iOS Simulator. Supports custom URL schemes (myapp://path) and universal links (https://...). Optionally returns unified-log entries around the open event via `captureLogs` (see docs/recipes/universal-link-channels.md).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'Deep link URL (custom scheme or universal link)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          captureLogs: {
            type: 'object',
            description:
              'If provided, synchronously captures os_log entries around the deep-link open. Collection stops after `silenceMs` with no new matching entry, or `maxDurationMs` elapses.',
            properties: {
              bundleId: { type: 'string' },
              level: { type: 'string', enum: ['default', 'info', 'debug', 'error', 'fault'] },
              search: { type: 'string' },
              prerollMs: { type: 'number' },
              silenceMs: { type: 'number' },
              maxDurationMs: { type: 'number' },
            },
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string;

      if (!url) {
        return {
          content: [{ type: 'text' as const, text: 'Error: url is required' }],
          isError: true,
        };
      }

      // Basic URL validation — must contain a scheme
      if (!url.includes('://')) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: invalid URL — must include a scheme (e.g. https:// or myapp://)',
            },
          ],
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

      try {
        const simctl = new SimctlExecutor();
        const preOpenAt = Date.now();
        await simctl.exec(['openurl', deviceId, url]);

        const result: Record<string, unknown> = {
          url,
          deviceId,
          openedAt: new Date(preOpenAt).toISOString(),
        };

        const captureLogsOpts = params.captureLogs as CaptureLogsOptions | undefined;
        if (captureLogsOpts && typeof captureLogsOpts === 'object') {
          result.logs = await captureLogsWindow(deviceId, preOpenAt, captureLogsOpts, { simctl });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: failed to open URL "${url}": ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
