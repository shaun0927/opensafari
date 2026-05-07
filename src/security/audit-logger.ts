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
  args_summary: string;   // brief summary, no sensitive data
}

const AUDIT_DIR_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;
export const MAX_AUDIT_LOG_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_STRING_LENGTH = 100;
const REDACTED = '[REDACTED]';

// Get log file path
function getLogPath(): string {
  return process.env.OPENSAFARI_AUDIT_LOG_PATH ?? path.join(os.homedir(), '.opensafari', 'audit.log');
}

// Extract domain from URL safely
function extractDomain(url?: string): string | null {
  if (!url) return null;
  return extractHostname(url) || null;
}

const SENSITIVE_KEYS = [
  'password',
  'cookie',
  'token',
  'secret',
  'auth',
  'authorization',
  'credential',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'privatekey',
  'private_key',
  'session',
  // Free-form user input that flows through MCP tool calls (e.g.
  // `type.text`, `select_option.value`) can carry passwords or OTPs, so
  // redact these keys defensively even though they are not credentials
  // by name.
  'text',
  'value',
];

const SENSITIVE_QUERY_PARAMS = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'code',
  'cookie',
  'credential',
  'key',
  'password',
  'refresh_token',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
];

// Match either the full lowercased key, or any segment of it against
// the provided list. Segments are split on `_` / `-` and on camelCase
// boundaries so `apiKey`, `accessToken`, and `refreshToken` are caught
// while `monkey` / `keyboard` / `context` are not. Trailing plural `s`
// on a segment is stripped before comparison.
function matchesSensitiveTerm(key: string, terms: readonly string[]): boolean {
  const lower = key.toLowerCase();
  if (matchSegment(lower, terms)) return true;
  for (const segment of splitIntoSegments(key)) {
    if (segment && matchSegment(segment.toLowerCase(), terms)) return true;
  }
  return false;
}

// Split on `_` / `-` and camelCase boundaries (`apiKey` → `api`, `Key`;
// `XMLHttp` → `XML`, `Http`).
function splitIntoSegments(key: string): string[] {
  return key.split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
}

function matchSegment(segment: string, terms: readonly string[]): boolean {
  if (terms.includes(segment)) return true;
  return segment.endsWith('s') && terms.includes(segment.slice(0, -1));
}

function isSensitiveKey(key: string): boolean {
  return matchesSensitiveTerm(key, SENSITIVE_KEYS);
}

function isSensitiveQueryParam(key: string): boolean {
  return matchesSensitiveTerm(key, SENSITIVE_QUERY_PARAMS);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let redacted = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      redacted = true;
    }
    url.searchParams.forEach((_paramValue, key) => {
      if (isSensitiveQueryParam(key)) {
        url.searchParams.set(key, REDACTED);
        redacted = true;
      }
    });
    return redacted ? url.toString() : value;
  } catch {
    return value;
  }
}

function summarizeString(value: string): string {
  const redactedUrl = redactUrl(value);
  return redactedUrl.length > MAX_SUMMARY_STRING_LENGTH
    ? `${redactedUrl.slice(0, MAX_SUMMARY_STRING_LENGTH)}...`
    : redactedUrl;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return summarizeString(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const redactedArray = value.map(item => redactValue(item, seen));
    seen.delete(value);
    return redactedArray;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const safe: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      safe[key] = isSensitiveKey(key) ? REDACTED : redactValue(nestedValue, seen);
    }
    seen.delete(value);
    return safe;
  }

  return value;
}

// Summarize args (redact sensitive values)
function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(redactValue(args, new WeakSet<object>()));
}

// Remember which log paths have been successfully prepped so that we do
// not run mkdir/chmod on every audit entry. `getLogPath()` reads from
// env at call time, so we key by path to stay correct if it changes.
//
// Only successes are cached — a transient mkdir/chmod failure (e.g. a
// not-yet-mounted volume at startup) must not permanently disable audit
// writes for the rest of the process, so we retry setup on subsequent
// calls until it succeeds.
const ensuredLogPaths = new Set<string>();

function ensurePrivateLogTarget(logPath: string): boolean {
  if (ensuredLogPaths.has(logPath)) return true;

  const logDir = path.dirname(logPath);
  try {
    // Only tighten directory permissions on directories we own (i.e. that
    // we just created). When OPENSAFARI_AUDIT_LOG_PATH points at a shared
    // location (e.g. /var/log), unconditionally chmod-ing the parent
    // could break other services that rely on its existing mode.
    const dirExisted = fs.existsSync(logDir);
    fs.mkdirSync(logDir, { recursive: true, mode: AUDIT_DIR_MODE });
    if (!dirExisted) {
      fs.chmodSync(logDir, AUDIT_DIR_MODE);
    }
    if (fs.existsSync(logPath)) {
      fs.chmodSync(logPath, AUDIT_FILE_MODE);
    }
    ensuredLogPaths.add(logPath);
    return true;
  } catch {
    return false;
  }
}

function rotateLogIfNeeded(logPath: string, bytesToAppend: number): void {
  if (!fs.existsSync(logPath)) return;

  const size = fs.statSync(logPath).size;
  if (size + bytesToAppend <= MAX_AUDIT_LOG_BYTES) return;

  const rotatedPath = `${logPath}.1`;
  fs.rmSync(rotatedPath, { force: true });
  fs.renameSync(logPath, rotatedPath);
  fs.chmodSync(rotatedPath, AUDIT_FILE_MODE);
}

export function logAuditEntry(tool: string, sessionId: string, args: Record<string, unknown>, pageUrl?: string): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    tool,
    domain: extractDomain(pageUrl || (args.url as string)),
    sessionId,
    args_summary: summarizeArgs(args),
  };

  const logPath = getLogPath();
  if (!ensurePrivateLogTarget(logPath)) return;

  const line = JSON.stringify(entry) + '\n';
  try {
    rotateLogIfNeeded(logPath, Buffer.byteLength(line));
    fs.appendFileSync(logPath, line, { mode: AUDIT_FILE_MODE });
  } catch (err) {
    console.error('[audit-logger] write failed:', (err as NodeJS.ErrnoException).code);
  }
}
