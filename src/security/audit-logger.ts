/**
 * Audit Logger - Logs tool invocations for security review
 * Writes structured JSONL to ~/.opensafari/audit.log
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractHostname } from '../utils/url-utils';

interface AuditEntry {
  timestamp: string;      // ISO 8601
  tool: string;           // tool name
  domain: string | null;  // extracted from page URL, null if N/A
  sessionId: string;
  status?: string;
  args_summary: string;   // brief summary, no sensitive data
}

let logDirEnsured = false;

// Get log file path
function getLogPath(): string {
  return path.join(os.homedir(), '.opensafari', 'audit.log');
}

// Extract domain from URL safely
function extractDomain(url?: string): string | null {
  if (!url) return null;
  return extractHostname(url) || null;
}

const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'cookie',
  'token',
  'secret',
  'auth',
  'credential',
  'authorization',
  'session',
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some(s => lower.includes(s));
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      safe[key] = isSensitiveKey(key) ? '[REDACTED]' : redactValue(nestedValue);
    }
    return safe;
  }
  if (typeof value === 'string' && value.length > 100) {
    return value.slice(0, 100) + '...';
  }
  return value;
}

// Summarize args (redact sensitive values)
function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(redactValue(args));
}

export function logAuditEntry(
  tool: string,
  sessionId: string,
  args: Record<string, unknown>,
  pageUrl?: string,
  status?: string,
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    tool,
    domain: extractDomain(pageUrl || (args.url as string)),
    sessionId,
    ...(status ? { status } : {}),
    args_summary: summarizeArgs(args),
  };

  const logPath = getLogPath();
  const logDir = path.dirname(logPath);

  // Ensure directory exists (first time only)
  if (!logDirEnsured) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logDirEnsured = true;
    } catch {
      return; // Non-fatal
    }
  }

  // Non-blocking append
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(logPath, line, (err) => { if (err) console.error('[audit-logger] write failed:', (err as NodeJS.ErrnoException).code); });
}
