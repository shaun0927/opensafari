import { MCPServer, getWebKitClient } from '../mcp-server';

interface NetworkLogEntry {
  requestId: string;
  url: string;
  method: string;
  status: number;
  mimeType: string;
  timestamp: number;
  responseBody?: string;
}

interface NetworkLogState {
  enabled: boolean;
  captureBody: boolean;
  entries: NetworkLogEntry[];
  maxEntries: number;
  pendingRequests: Map<string, { url: string; method: string; timestamp: number }>;
}

const state: NetworkLogState = {
  enabled: false,
  captureBody: false,
  entries: [],
  maxEntries: 500,
  pendingRequests: new Map(),
};

function resetState(): void {
  state.enabled = false;
  state.captureBody = false;
  state.entries = [];
  state.pendingRequests.clear();
}

const CAPTURABLE_MIME_PREFIXES = ['text/', 'application/json'];

function shouldCaptureBody(mimeType: string): boolean {
  return CAPTURABLE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

export { shouldCaptureBody, NetworkLogEntry };

export function registerNetworkLogTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_log',
      description:
        'Capture network activity log. Start/stop logging, retrieve entries, and optionally capture response bodies for text/JSON responses.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'get', 'clear'],
            description: 'start: begin logging, stop: end logging, get: retrieve entries, clear: reset log',
          },
          captureBody: {
            type: 'boolean',
            description: 'Capture response bodies for text/* and application/json (default false, start only)',
          },
          limit: {
            type: 'number',
            description: 'Max entries to return (default 100, for get action)',
          },
          urlFilter: {
            type: 'string',
            description: 'Filter entries by URL substring (for get action)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };

      const action = params.action as string;

      switch (action) {
        case 'start': {
          if (state.enabled) {
            return { content: [{ type: 'text' as const, text: 'Network logging already active' }] };
          }
          state.enabled = true;
          state.captureBody = (params.captureBody as boolean) ?? false;
          state.entries = [];
          state.pendingRequests.clear();

          // Enable Network domain and attach listeners
          await (client as any).enableDomain('Network');

          (client as any).on('Network.requestWillBeSent', (p: any) => {
            if (!state.enabled) return;
            const reqId = p.requestId ?? String(Date.now());
            state.pendingRequests.set(reqId, {
              url: p.request?.url ?? '',
              method: p.request?.method ?? 'GET',
              timestamp: Date.now(),
            });
          });

          (client as any).on('Network.responseReceived', async (p: any) => {
            if (!state.enabled) return;
            const reqId = p.requestId ?? '';
            const pending = state.pendingRequests.get(reqId);
            const entry: NetworkLogEntry = {
              requestId: reqId,
              url: pending?.url ?? p.response?.url ?? '',
              method: pending?.method ?? 'GET',
              status: p.response?.status ?? 0,
              mimeType: p.response?.mimeType ?? '',
              timestamp: pending?.timestamp ?? Date.now(),
            };

            // Capture response body if enabled and MIME type is text-based
            if (state.captureBody && shouldCaptureBody(entry.mimeType)) {
              try {
                const body = await (client as any).send('Network.getResponseBody', { requestId: reqId });
                if (body?.body) {
                  entry.responseBody = body.base64Encoded
                    ? Buffer.from(body.body, 'base64').toString('utf-8')
                    : body.body;
                }
              } catch {
                // Response body may not be available for all requests
              }
            }

            state.pendingRequests.delete(reqId);
            state.entries.push(entry);
            if (state.entries.length > state.maxEntries) {
              state.entries.shift();
            }
          });

          return { content: [{ type: 'text' as const, text: 'Network logging started' + (state.captureBody ? ' (with body capture)' : '') }] };
        }

        case 'stop': {
          const count = state.entries.length;
          state.enabled = false;
          return { content: [{ type: 'text' as const, text: 'Network logging stopped. ' + count + ' entries captured.' }] };
        }

        case 'get': {
          const limit = (params.limit as number) ?? 100;
          const urlFilter = params.urlFilter as string | undefined;
          let results = state.entries;
          if (urlFilter) {
            results = results.filter((e) => e.url.includes(urlFilter));
          }
          results = results.slice(-limit);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                total: state.entries.length,
                returned: results.length,
                logging: state.enabled,
                entries: results,
              }),
            }],
          };
        }

        case 'clear': {
          const cleared = state.entries.length;
          state.entries = [];
          state.pendingRequests.clear();
          return { content: [{ type: 'text' as const, text: cleared + ' entries cleared' }] };
        }

        default:
          return { content: [{ type: 'text' as const, text: 'Error: unknown action "' + action + '"' }], isError: true };
      }
    },
  );
}
