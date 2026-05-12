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

  it('redacts camelCase secret keys (apiKey, accessToken, refreshToken)', () => {
    logAuditEntry('http_request', 'session-camel', {
      headers: {
        apiKey: 'fake-api-key-camel',
        accessToken: 'fake-access-token-camel',
        refreshToken: 'fake-refresh-token-camel',
      },
      // Non-credential look-alike keys must NOT be redacted
      monkey: 'visible-monkey',
      keyboard: 'visible-keyboard',
      context: 'visible-context',
    });

    const [entry] = readAuditEntries(tmpHome);
    const summary = parseArgsSummary(entry);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('fake-api-key-camel');
    expect(serialized).not.toContain('fake-access-token-camel');
    expect(serialized).not.toContain('fake-refresh-token-camel');
    expect(serialized).toContain('visible-monkey');
    expect(serialized).toContain('visible-keyboard');
    expect(serialized).toContain('visible-context');
    expect(summary).toMatchObject({
      headers: {
        apiKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
      },
    });
  });

  it('redacts free-form text and value fields from audit summaries', () => {
    logAuditEntry('app_type_text', 'session-freeform', {
      text: 'otp-123456',
      nested: {
        value: 'selected-secret-value',
        label: 'visible-label',
      },
      items: [
        { text: 'password typed into field' },
        { value: 'token pasted into selector' },
      ],
    });

    const [entry] = readAuditEntries(tmpHome);
    const summary = parseArgsSummary(entry);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('otp-123456');
    expect(serialized).not.toContain('selected-secret-value');
    expect(serialized).not.toContain('password typed into field');
    expect(serialized).not.toContain('token pasted into selector');
    expect(serialized).toContain('visible-label');
    expect(summary).toMatchObject({
      text: '[REDACTED]',
      nested: {
        value: '[REDACTED]',
        label: 'visible-label',
      },
      items: [
        { text: '[REDACTED]' },
        { value: '[REDACTED]' },
      ],
    });
  });

  it('retries log target setup after a transient initialization error', () => {
    // Point the logger at a path under a parent that doesn't yet exist and
    // can't be created (a regular file, so mkdir(recursive) will EEXIST/ENOTDIR).
    // First call: setup fails, no log is written.
    // Then we replace the blocker with a real directory and call again — the
    // second call must retry setup (not return cached failure) and succeed.
    const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-blocker-'));
    const blockedParent = path.join(blockerDir, 'parent');
    fs.writeFileSync(blockedParent, ''); // a *file* where the dir is expected
    const logPathUnderBlocker = path.join(blockedParent, 'audit.log');

    const previous = process.env.OPENSAFARI_AUDIT_LOG_PATH;
    process.env.OPENSAFARI_AUDIT_LOG_PATH = logPathUnderBlocker;
    try {
      // First attempt — setup must fail because parent is a regular file
      logAuditEntry('navigate', 'session-init-fail', { url: 'https://example.test/' });
      expect(fs.existsSync(logPathUnderBlocker)).toBe(false);

      // Remove the blocker; the path is now legitimately constructable
      fs.unlinkSync(blockedParent);

      // Second attempt — must retry setup and succeed (no permanent disable)
      logAuditEntry('navigate', 'session-init-recover', { url: 'https://example.test/recover' });
      expect(fs.existsSync(logPathUnderBlocker)).toBe(true);
      const recovered = fs.readFileSync(logPathUnderBlocker, 'utf8').trim().split('\n');
      expect(recovered).toHaveLength(1);
      const entry = JSON.parse(recovered[0]) as Record<string, unknown>;
      expect(entry.sessionId).toBe('session-init-recover');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAFARI_AUDIT_LOG_PATH;
      } else {
        process.env.OPENSAFARI_AUDIT_LOG_PATH = previous;
      }
      fs.rmSync(blockerDir, { recursive: true, force: true });
    }
  });

  it('does not chmod a directory mistakenly configured as the log path', () => {
    // If OPENSAFARI_AUDIT_LOG_PATH is misconfigured to point at a
    // directory, the logger must not strip the directory's execute
    // bits — that would break traversal for other services/users.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-dir-target-'));
    const dirAsLogPath = path.join(root, 'audit.log'); // we'll mkdir it
    fs.mkdirSync(dirAsLogPath, { mode: 0o755 });
    const beforeMode = fs.statSync(dirAsLogPath).mode & 0o777;

    const previous = process.env.OPENSAFARI_AUDIT_LOG_PATH;
    process.env.OPENSAFARI_AUDIT_LOG_PATH = dirAsLogPath;
    try {
      // The append will fail (EISDIR), but ensurePrivateLogTarget must
      // not chmod the directory to 0o600 along the way.
      logAuditEntry('navigate', 'session-dir-target', { url: 'https://example.test/' });

      const afterMode = fs.statSync(dirAsLogPath).mode & 0o777;
      expect(afterMode).toBe(beforeMode);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAFARI_AUDIT_LOG_PATH;
      } else {
        process.env.OPENSAFARI_AUDIT_LOG_PATH = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not chmod a pre-existing parent log directory', () => {
    // Pre-create the log directory with a permissive mode (e.g. shared
    // /var/log) and verify the audit logger does NOT tighten it.
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-shared-'));
    const sharedLogPath = path.join(sharedDir, 'audit.log');
    fs.chmodSync(sharedDir, 0o755);
    const beforeMode = fs.statSync(sharedDir).mode & 0o777;

    const previous = process.env.OPENSAFARI_AUDIT_LOG_PATH;
    process.env.OPENSAFARI_AUDIT_LOG_PATH = sharedLogPath;
    try {
      logAuditEntry('navigate', 'session-shared', { url: 'https://example.test/' });

      const afterMode = fs.statSync(sharedDir).mode & 0o777;
      expect(afterMode).toBe(beforeMode);
      // The audit file itself must still be created with private mode
      expect(fs.statSync(sharedLogPath).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAFARI_AUDIT_LOG_PATH;
      } else {
        process.env.OPENSAFARI_AUDIT_LOG_PATH = previous;
      }
      fs.rmSync(sharedDir, { recursive: true, force: true });
    }
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
