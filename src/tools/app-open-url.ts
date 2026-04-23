import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-utils';
import {
  captureLogsWindow,
  type CaptureLogsOptions,
} from '../observability/capture-logs-window';

export function registerAppOpenUrlTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_open_url',
      description:
        'Open a URL or deep link on an iOS Simulator. Routes to the appropriate app handler (e.g. Safari for https://, or a custom scheme like myapp://). Optionally returns unified-log entries around the open event via `captureLogs` (see docs/recipes/universal-link-channels.md).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'URL or deep link to open (e.g. myapp://path, https://example.com)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          captureLogs: {
            type: 'object',
            description:
              'If provided, synchronously captures os_log entries around the URL-open. Collection stops after `silenceMs` with no new matching entry, or `maxDurationMs` elapses.',
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
      try {
        const deviceId = resolveDeviceId(params);
        const url = params.url as string;

        if (!url) {
          throw new Error('url parameter is required');
        }

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
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_open_url] Error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
