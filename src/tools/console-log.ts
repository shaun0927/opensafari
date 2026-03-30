import { MCPServer, getWebKitClient } from '../mcp-server';
import { BufferedEventCollector, CollectedEvent } from '../utils/buffered-event-collector';

export interface ConsoleEntry extends CollectedEvent {
  level: string;
  message: string;
}

const collectors = new Map<string, BufferedEventCollector<ConsoleEntry>>();
let attachedClient: unknown = null;

function getOrCreateCollector(sid: string): BufferedEventCollector<ConsoleEntry> {
  let c = collectors.get(sid);
  if (!c) { c = new BufferedEventCollector<ConsoleEntry>(500); collectors.set(sid, c); }
  return c;
}

export function registerConsoleLogTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'console_log',
      description: 'Start/stop console message collection and retrieve buffered browser console output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'get'], description: 'start/stop/get' },
          level: { type: 'string', enum: ['log', 'warn', 'error', 'debug', 'info'], description: 'Filter by level (get only)' },
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
        if (attachedClient !== client) {
          client.onConsole((msg: { type: string; text: string }) => {
            for (const c of collectors.values()) {
              c.push({ timestamp: Date.now(), level: msg.type, message: msg.text });
            }
          });
          attachedClient = client;
        }
        collector.start();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'collecting', message: 'Console collection started' }) }] };
      }
      if (action === 'stop') {
        collector.stop();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'stopped', buffered: collector.size }) }] };
      }
      let entries = collector.get();
      const level = params.level as string | undefined;
      if (level) entries = entries.filter((e) => e.level === level);
      if (params.clear) collector.clear();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: entries.length, entries }) }] };
    },
  );
}
