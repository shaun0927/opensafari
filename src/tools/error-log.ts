import { MCPServer, getWebKitClient } from '../mcp-server';
import { BufferedEventCollector, CollectedEvent } from '../utils/buffered-event-collector';

export interface ErrorEntry extends CollectedEvent {
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
}

const collectors = new Map<string, BufferedEventCollector<ErrorEntry>>();
let attachedClient: unknown = null;

function getOrCreateCollector(sid: string): BufferedEventCollector<ErrorEntry> {
  let c = collectors.get(sid);
  if (!c) { c = new BufferedEventCollector<ErrorEntry>(500); collectors.set(sid, c); }
  return c;
}

export function registerErrorLogTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'error_log',
      description: 'Start/stop capturing unhandled JavaScript errors and promise rejections.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'get'], description: 'start/stop/get' },
          clear: { type: 'boolean', description: 'Clear buffer after get' },
        },
        required: ['action'],
      },
    },
    async (sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client) return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const action = params.action as 'start' | 'stop' | 'get';
      const collector = getOrCreateCollector(sessionId);

      if (action === 'start') {
        if (attachedClient !== client && (client as any).onError) {
          (client as any).onError((error: { message: string; stack?: string; source?: string; line?: number; column?: number }) => {
            for (const c of collectors.values()) {
              c.push({ timestamp: Date.now(), message: error.message, stack: error.stack, source: error.source, line: error.line, column: error.column });
            }
          });
          attachedClient = client;
        }
        collector.start();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'capturing', message: 'Error capture started' }) }] };
      }
      if (action === 'stop') {
        collector.stop();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'stopped', buffered: collector.size }) }] };
      }
      const entries = collector.get();
      if (params.clear) collector.clear();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: entries.length, entries }) }] };
    },
  );
}
