import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../../src/mcp-server';
import { MAX_AUDIT_LOG_BYTES, logAuditEntry } from '../../src/security/audit-logger';

function readAuditEntries(home: string): Array<Record<string, unknown>> {
  const logPath = path.join(home, '.opensafari', 'audit.log');
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function parseArgsSummary(entry: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(entry.args_summary as string) as Record<string, unknown>;
}

describe('audit logger', () => {
  let tmpHome: string;
  let previousAuditLogPath: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-'));
    previousAuditLogPath = process.env.OPENSAFARI_AUDIT_LOG_PATH;
    process.env.OPENSAFARI_AUDIT_LOG_PATH = path.join(tmpHome, '.opensafari', 'audit.log');
  });

  afterEach(() => {
    if (previousAuditLogPath === undefined) {
      delete process.env.OPENSAFARI_AUDIT_LOG_PATH;
    } else {
      process.env.OPENSAFARI_AUDIT_LOG_PATH = previousAuditLogPath;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('recursively redacts sensitive nested objects, arrays, and URL query parameters', () => {
    logAuditEntry('http_request', 'session-1', {
      url: 'https://example.test/path?token=fake-token&safe=visible&client_secret=fake-secret',
      headers: {
        authorization: 'Bearer fake-token',
        nested: [
          { refresh_token: 'fake-refresh-token' },
          'https://example.test/callback?code=fake-code&state=ok',
        ],
      },
      body: {
        user: 'alice',
        password: 'fake-password',
        profile: [{ cookie: 'fake-cookie' }],
      },
    });

    const [entry] = readAuditEntries(tmpHome);
    const summary = parseArgsSummary(entry);

    expect(entry.domain).toBe('example.test');
    expect(JSON.stringify(summary)).not.toContain('fake-token');
    expect(JSON.stringify(summary)).not.toContain('fake-secret');
    expect(JSON.stringify(summary)).not.toContain('fake-refresh-token');
    expect(JSON.stringify(summary)).not.toContain('fake-code');
    expect(JSON.stringify(summary)).not.toContain('fake-password');
    expect(JSON.stringify(summary)).not.toContain('fake-cookie');
    expect(JSON.stringify(summary)).toContain('safe=visible');
    expect(JSON.stringify(summary)).toContain('state=ok');
    expect(summary).toMatchObject({
      headers: {
        authorization: '[REDACTED]',
      },
      body: {
        password: '[REDACTED]',
      },
    });
  });

  it('creates the audit directory and file with private POSIX permissions', () => {
    logAuditEntry('navigate', 'session-1', { url: 'https://example.test/' });

    const logDir = path.join(tmpHome, '.opensafari');
    const logPath = path.join(logDir, 'audit.log');

    expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('rotates the local audit log before it exceeds the configured byte cap', () => {
    const logDir = path.join(tmpHome, '.opensafari');
    const logPath = path.join(logDir, 'audit.log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, Buffer.alloc(MAX_AUDIT_LOG_BYTES, 'x'), { mode: 0o600 });

    logAuditEntry('navigate', 'session-1', { url: 'https://example.test/' });

    const rotatedPath = `${logPath}.1`;
    expect(fs.existsSync(rotatedPath)).toBe(true);
    expect(fs.statSync(rotatedPath).size).toBe(MAX_AUDIT_LOG_BYTES);
    expect(fs.statSync(rotatedPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(logPath).size).toBeLessThan(MAX_AUDIT_LOG_BYTES);
    expect(readAuditEntries(tmpHome)).toHaveLength(1);
  });

  it('redacts fake high-risk HTTP secrets emitted through MCP tool-call auditing', async () => {
    const server = new MCPServer();
    server.enableAuditLog();
    server.registerTool(
      {
        name: 'http_request',
        description: 'test HTTP request',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );

    await (server as unknown as {
      handleMessage(msg: Record<string, unknown>): Promise<unknown>;
    }).handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'http_request',
        arguments: {
          url: 'https://api.example.test/data?api_key=fake-api-key',
          headers: { authorization: 'Bearer fake-token' },
          payload: [{ token: 'fake-token' }],
        },
      },
    });

    const rawLog = fs.readFileSync(path.join(tmpHome, '.opensafari', 'audit.log'), 'utf8');
    expect(rawLog).toContain('http_request');
    expect(rawLog).not.toContain('fake-api-key');
    expect(rawLog).not.toContain('fake-token');
  });
});
