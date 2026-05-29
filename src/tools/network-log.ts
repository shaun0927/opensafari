import { MCPServer, getWebKitClient } from '../mcp-server';
import { BufferedEventCollector, CollectedEvent } from '../utils/buffered-event-collector';
import { ErrorCode, respondWithStructuredError } from '../errors';

export interface NetworkEntry extends CollectedEvent {
  url: string;
  method: string;
  status?: number;
  type: 'request' | 'response';
}

const collectors = new Map<string, BufferedEventCollector<NetworkEntry>>();
let attachedClient: unknown = null;

function getOrCreateCollector(sid: string): BufferedEventCollector<NetworkEntry> {
  let c = collectors.get(sid);
  if (!c) { c = new BufferedEventCollector<NetworkEntry>(500); collectors.set(sid, c); }
  return c;
}

export function registerNetworkLogTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_log',
      description: 'Start/stop network request monitoring and retrieve buffered HTTP request/response metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'get'], description: 'start/stop/get' },
          urlFilter: { type: 'string', description: 'Regex to filter by URL (get only)' },
          clear: { type: 'boolean', description: 'Clear buffer after get' },
        },
        required: ['action'],
      },
    },
    async (sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client) return respondWithStructuredError(ErrorCode.BACKEND_NOT_CONNECTED, 'Safari not connected');
      const action = params.action as 'start' | 'stop' | 'get';
      const collector = getOrCreateCollector(sessionId);

      if (action === 'start') {
        if (attachedClient !== client) {
          client.onRequest((req: { url: string; method: string }) => {
            for (const c of collectors.values()) {
              c.push({ timestamp: Date.now(), type: 'request', url: req.url, method: req.method });
            }
          });
          client.onResponse((res: { url: string; status: number }) => {
            for (const c of collectors.values()) {
              c.push({ timestamp: Date.now(), type: 'response', url: res.url, method: '', status: res.status });
            }
          });
          attachedClient = client;
        }
        collector.start();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'monitoring', message: 'Network monitoring started' }) }] };
      }
      if (action === 'stop') {
        collector.stop();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'stopped', buffered: collector.size }) }] };
      }
      if (action === 'get') {
        let entries = collector.get();
        const urlFilter = params.urlFilter as string | undefined;
        if (urlFilter) {
          let re: RegExp;
          try { re = new RegExp(urlFilter); }
          catch { return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'Invalid regex filter'); }
          entries = entries.filter((e) => re.test(e.url));
        }
        if (params.clear) collector.clear();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ count: entries.length, entries }) }] };
      }
      return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Unknown action: ${action}`);
    },
  );
}
