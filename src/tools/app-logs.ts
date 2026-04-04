/**
 * app_logs — Capture device/app logs from the simulator.
 *
 * Uses `simctl spawn <device> log show` to retrieve system log entries,
 * with optional filtering by bundle ID, log level, time range, and search string.
 */

import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId, parseDuration } from './native-observability-utils';

/** Map human-readable log level names to NSPredicate messageType values. */
const LOG_LEVEL_MAP: Record<string, number> = {
  default: 0,
  info: 1,
  debug: 2,
  error: 16,
  fault: 17,
};

/**
 * Build an NSPredicate string from the filter parameters.
 */
export function buildLogPredicate(opts: {
  bundleId?: string;
  level?: string;
  search?: string;
}): string | null {
  const clauses: string[] = [];

  if (opts.bundleId) {
    clauses.push(`process == "${opts.bundleId}"`);
  }
  if (opts.level && opts.level !== 'default') {
    const typeValue = LOG_LEVEL_MAP[opts.level];
    if (typeValue !== undefined) {
      clauses.push(`messageType >= ${typeValue}`);
    }
  }
  if (opts.search) {
    // Escape double quotes in search string
    const safe = opts.search.replace(/"/g, '\\"');
    clauses.push(`composedMessage CONTAINS "${safe}"`);
  }

  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

export function registerAppLogsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_logs',
      description:
        'Capture device or app logs from the simulator. Supports filtering by bundle ID, log level, time range, and search string.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: { type: 'string', description: 'Filter logs by app bundle identifier' },
          deviceId: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
          level: {
            type: 'string',
            enum: ['default', 'info', 'debug', 'error', 'fault'],
            description: 'Minimum log level (default: default)',
          },
          since: {
            type: 'string',
            description: 'Time filter: e.g. "1m" (1 minute ago), "5m", "1h", "30s"',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of log entries to return (default: 100)',
          },
          search: { type: 'string', description: 'Search string to filter log messages' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string | undefined;
      const level = (params.level as string) || 'default';
      const since = (params.since as string) || '1m';
      const limit = (params.limit as number) || 100;
      const search = params.search as string | undefined;

      // Validate duration format
      try {
        parseDuration(since);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const simctl = new SimctlExecutor();
      const predicate = buildLogPredicate({ bundleId, level, search });

      try {
        const args: string[] = ['spawn', deviceId, 'log', 'show', '--last', since, '--style', 'json'];
        if (predicate) {
          args.push('--predicate', predicate);
        }

        const output = await simctl.exec(args, { timeout: 30000 });

        // Parse log entries from JSON output
        let entries: Array<Record<string, unknown>> = [];
        try {
          // log show --style json returns a JSON array
          const parsed = JSON.parse(output);
          entries = Array.isArray(parsed) ? parsed : [];
        } catch {
          // Sometimes log show returns line-delimited output or non-JSON
          // Fall back to splitting by lines and returning raw text entries
          const lines = output.split('\n').filter((l) => l.trim());
          entries = lines.map((line) => ({ message: line }));
        }

        const truncated = entries.length > limit;
        const limited = entries.slice(0, limit);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                deviceId,
                bundleId: bundleId ?? null,
                level,
                since,
                entries: limited,
                count: limited.length,
                truncated,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching logs: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
