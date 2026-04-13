/**
 * flutter_logs — Capture Dart print()/debugPrint() log output from a Flutter app.
 *
 * Subscribes to the Stdout and Stderr VM Service streams and collects
 * log entries. Returns captured logs on demand.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

interface LogEntry {
  timestamp: number;
  stream: string;
  message: string;
}

// Per-device log buffers
const logBuffers = new Map<string, LogEntry[]>();
const subscribed = new Set<string>();

const MAX_LOG_ENTRIES = 500;

export function registerFlutterLogsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_logs',
      description:
        'Capture Dart print()/debugPrint() log output from a connected Flutter app. ' +
        'First call starts capturing; subsequent calls return accumulated logs. ' +
        'Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'get', 'clear'],
            description: 'Action: "start" begins capturing, "get" returns logs, "clear" empties buffer (default: "get")',
          },
          filter: {
            type: 'string',
            description: 'Filter log messages by substring (case-insensitive)',
          },
          limit: {
            type: 'number',
            description: 'Max number of log entries to return (default: 100)',
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
          throw new Error('No device specified and no active device.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        const action = (params.action as string | undefined) ?? 'get';
        const filter = params.filter as string | undefined;
        const limit = (params.limit as number | undefined) ?? 100;

        if (action === 'start' || !subscribed.has(deviceId)) {
          // Initialize buffer and subscribe to streams
          if (!logBuffers.has(deviceId)) {
            logBuffers.set(deviceId, []);
          }

          if (!subscribed.has(deviceId)) {
            // Subscribe to Stdout and Stderr streams
            try { await client.streamListen('Stdout'); } catch { /* may already be subscribed */ }
            try { await client.streamListen('Stderr'); } catch { /* may already be subscribed */ }

            // Register event handlers
            client.onEvent('Stdout', (event) => {
              const message = event.bytes
                ? Buffer.from(event.bytes, 'base64').toString('utf8')
                : event.message ?? '';
              if (message.trim()) {
                addLogEntry(deviceId, 'stdout', message.trim());
              }
            });

            client.onEvent('Stderr', (event) => {
              const message = event.bytes
                ? Buffer.from(event.bytes, 'base64').toString('utf8')
                : event.message ?? '';
              if (message.trim()) {
                addLogEntry(deviceId, 'stderr', message.trim());
              }
            });

            subscribed.add(deviceId);
          }

          if (action === 'start') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'capturing',
                  deviceId,
                  message: 'Log capture started. Call flutter_logs with action "get" to retrieve logs.',
                }),
              }],
            };
          }
        }

        if (action === 'clear') {
          logBuffers.set(deviceId, []);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ status: 'cleared', deviceId }),
            }],
          };
        }

        // action === 'get'
        let entries = logBuffers.get(deviceId) ?? [];

        if (filter) {
          const filterLower = filter.toLowerCase();
          entries = entries.filter((e) => e.message.toLowerCase().includes(filterLower));
        }

        const limited = entries.slice(-limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: entries.length,
              returned: limited.length,
              logs: limited.map((e) => ({
                time: new Date(e.timestamp).toISOString(),
                stream: e.stream,
                message: e.message,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_logs] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

function addLogEntry(deviceId: string, stream: string, message: string): void {
  const buffer = logBuffers.get(deviceId) ?? [];
  buffer.push({ timestamp: Date.now(), stream, message });

  // Trim buffer if too large
  while (buffer.length > MAX_LOG_ENTRIES) {
    buffer.shift();
  }

  logBuffers.set(deviceId, buffer);
}
