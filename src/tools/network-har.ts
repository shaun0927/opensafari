import { MCPServer, getWebKitClient } from '../mcp-server';
import { WebKitClient } from '../webkit/client';
import { HarCollector } from '../network/har-collector';

let activeCollector: HarCollector | null = null;

export function registerNetworkHarTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_har',
      description: 'Capture network traffic and export as HAR 1.2 format for debugging',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'export'],
            description: 'start: begin capture, stop: end capture, export: get HAR data',
          },
          format: {
            type: 'string',
            enum: ['har', 'json'],
            description: 'Export format (default: har)',
          },
          captureBody: {
            type: 'boolean',
            description: 'Capture response bodies for text/JSON responses (default: false)',
          },
          maxBodySize: {
            type: 'number',
            description: 'Max response body size in bytes (default: 1048576 = 1MB)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };

      const action = params.action as 'start' | 'stop' | 'export';

      if (action === 'start') {
        if (activeCollector?.isRecording()) {
          return { content: [{ type: 'text' as const, text: 'HAR capture already in progress. Stop it first.' }], isError: true };
        }
        activeCollector = new HarCollector(client as WebKitClient, {
          captureBody: (params.captureBody as boolean) ?? false,
          maxBodySize: (params.maxBodySize as number) ?? undefined,
        });
        await activeCollector.start();
        return { content: [{ type: 'text' as const, text: 'HAR capture started' }] };
      }

      if (action === 'stop') {
        if (!activeCollector?.isRecording()) {
          return { content: [{ type: 'text' as const, text: 'No active HAR capture to stop' }], isError: true };
        }
        activeCollector.stop();
        const count = activeCollector.getEntryCount();
        return { content: [{ type: 'text' as const, text: `HAR capture stopped. ${count} entries recorded.` }] };
      }

      if (action === 'export') {
        if (!activeCollector) {
          return { content: [{ type: 'text' as const, text: 'No HAR data available. Start a capture first.' }], isError: true };
        }
        const format = (params.format as 'har' | 'json') ?? 'har';
        const data = activeCollector.export(format);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      }

      return { content: [{ type: 'text' as const, text: `Unknown action: ${action}` }], isError: true };
    },
  );
}
