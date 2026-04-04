/**
 * app_crash_reports — List and retrieve crash reports for simulator apps.
 *
 * Scans ~/Library/Logs/DiagnosticReports/ for .ips and .crash files,
 * optionally filtering by bundle/process name. Returns metadata and
 * the first few lines of each report.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../mcp-server';
import { resolveDeviceId } from './native-observability-utils';

const DIAGNOSTIC_REPORTS_DIR = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
const CRASH_EXTENSIONS = new Set(['.ips', '.crash']);
const MAX_PREVIEW_LINES = 50;

interface CrashReport {
  filename: string;
  date: string;
  process: string;
  exceptionType: string | null;
  reason: string | null;
  firstFewLines: string;
}

/**
 * Extract crash metadata from file content.
 */
function parseCrashContent(content: string, filename: string): Omit<CrashReport, 'date'> {
  let process = filename.replace(/\.(ips|crash)$/, '').split('_')[0];
  let exceptionType: string | null = null;
  let reason: string | null = null;

  // Try to parse as JSON (.ips format)
  try {
    const json = JSON.parse(content);
    if (json.procName) process = json.procName;
    if (json.exception?.type) exceptionType = json.exception.type;
    if (json.termination?.reason) reason = json.termination.reason;
    else if (json.exception?.message) reason = json.exception.message;
  } catch {
    // Plain text crash report
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('Process:')) {
        process = line.replace('Process:', '').trim().split(' ')[0];
      }
      if (line.startsWith('Exception Type:')) {
        exceptionType = line.replace('Exception Type:', '').trim();
      }
      if (line.startsWith('Exception Codes:') || line.startsWith('Termination Reason:')) {
        reason = line.split(':').slice(1).join(':').trim();
      }
    }
  }

  const firstFewLines = content.split('\n').slice(0, MAX_PREVIEW_LINES).join('\n');

  return { filename, process, exceptionType, reason, firstFewLines };
}

export function registerAppCrashReportsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_crash_reports',
      description:
        'List and retrieve crash reports for simulator apps. Scans DiagnosticReports for .ips and .crash files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: { type: 'string', description: 'Filter by app bundle identifier or process name' },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted, used for validation)',
          },
          limit: { type: 'number', description: 'Maximum number of reports (default: 5)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      // Validate device is available (even though crash reports are filesystem-based)
      try {
        resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string | undefined;
      const limit = (params.limit as number) || 5;

      try {
        // Check if directory exists
        try {
          await fs.access(DIAGNOSTIC_REPORTS_DIR);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  reports: [],
                  count: 0,
                  message: 'No DiagnosticReports directory found. No crash reports available.',
                }),
              },
            ],
          };
        }

        // List crash report files
        const entries = await fs.readdir(DIAGNOSTIC_REPORTS_DIR, { withFileTypes: true });
        let crashFiles = entries
          .filter((e) => e.isFile() && CRASH_EXTENSIONS.has(path.extname(e.name)))
          .map((e) => e.name);

        // Filter by bundleId/process name if provided
        if (bundleId) {
          const lower = bundleId.toLowerCase();
          crashFiles = crashFiles.filter((f) => f.toLowerCase().includes(lower));
        }

        // Get file stats and sort by modification time (newest first)
        const fileStats = await Promise.all(
          crashFiles.map(async (name) => {
            const fullPath = path.join(DIAGNOSTIC_REPORTS_DIR, name);
            const stat = await fs.stat(fullPath);
            return { name, mtime: stat.mtime, fullPath };
          }),
        );
        fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        // Apply limit
        const limited = fileStats.slice(0, limit);

        // Read and parse reports
        const reports: CrashReport[] = [];
        for (const file of limited) {
          try {
            const content = await fs.readFile(file.fullPath, 'utf-8');
            const parsed = parseCrashContent(content, file.name);
            reports.push({
              ...parsed,
              date: file.mtime.toISOString(),
            });
          } catch {
            // Skip files we cannot read
            reports.push({
              filename: file.name,
              date: file.mtime.toISOString(),
              process: file.name.split('_')[0],
              exceptionType: null,
              reason: null,
              firstFewLines: '(unable to read report)',
            });
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                reports,
                count: reports.length,
                totalAvailable: fileStats.length,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Error reading crash reports: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
