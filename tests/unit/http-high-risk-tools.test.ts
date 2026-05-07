import fs from 'fs';
import { MCPServer } from '../../src/mcp-server';
import { HTTP_HIGH_RISK_TOOLS_ENV, HTTP_HIGH_RISK_TOOLS_FLAG } from '../../src/security/high-risk-tools';
import { MCPMessageContext, MCPResponse } from '../../src/types/mcp';

function handleMessage(
  server: MCPServer,
  msg: Record<string, unknown>,
  context: MCPMessageContext,
): Promise<MCPResponse | null> {
  return (server as unknown as {
    handleMessage: (
      msg: Record<string, unknown>,
      context?: MCPMessageContext,
    ) => Promise<MCPResponse | null>;
  }).handleMessage(msg, context);
}

function enableHttpHighRiskTools(server: MCPServer): void {
  (server as unknown as { httpHighRiskToolsEnabled: boolean }).httpHighRiskToolsEnabled = true;
}

function registerHighRiskFixtures(server: MCPServer, calls: string[] = []): void {
  server.registerTool(
    {
      name: 'javascript',
      description: 'fixture high-risk code execution tool',
      inputSchema: {
        type: 'object' as const,
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
    async (_sessionId, params) => {
      calls.push(String(params.expression));
      return { content: [{ type: 'text' as const, text: 'executed' }] };
    },
  );

  server.registerTool(
    {
      name: 'auth_save',
      description: 'fixture high-risk credential movement tool',
      inputSchema: {
        type: 'object' as const,
        properties: { site: { type: 'string' } },
        required: ['site'],
      },
    },
    async () => ({ content: [{ type: 'text' as const, text: 'saved' }] }),
  );
}

describe('HTTP high-risk MCP tool gate', () => {
  const originalEnv = process.env.OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS;
  let mkdirSpy: jest.SpyInstance;
  let appendSpy: jest.SpyInstance;
  let auditLines: string[];

  beforeEach(() => {
    delete process.env.OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS;
    auditLines = [];
    mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);
    appendSpy = jest.spyOn(fs, 'appendFile').mockImplementation(((_path, data, cb) => {
      auditLines.push(String(data));
      if (typeof cb === 'function') cb(null);
    }) as typeof fs.appendFile);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS;
    } else {
      process.env.OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS = originalEnv;
    }
    appendSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  test('HTTP tools/list hides high-risk tools without the capability', async () => {
    const server = new MCPServer();
    registerHighRiskFixtures(server);
    server.setTier(3);

    const res = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
      params: {},
    }, { transport: 'http', sessionId: 'list-session' });

    const result = res?.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('javascript');
    expect(names).not.toContain('auth_save');
  });

  test('HTTP tools/list advertises high-risk tools with the capability', async () => {
    const server = new MCPServer();
    registerHighRiskFixtures(server);
    server.setTier(3);

    enableHttpHighRiskTools(server);
    const res = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {},
    }, { transport: 'http', sessionId: 'list-session' });

    const result = res?.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('javascript');
    expect(names).toContain('auth_save');
  });

  test('HTTP blocks code execution and auth movement tools without the capability', async () => {
    const server = new MCPServer();
    const calls: string[] = [];
    registerHighRiskFixtures(server, calls);

    const js = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'javascript', arguments: { expression: 'document.cookie' } },
    }, { transport: 'http', sessionId: 'http-session' });

    const jsResult = js?.result as Record<string, unknown>;
    const jsContent = jsResult.content as Array<Record<string, unknown>>;
    expect(jsResult.isError).toBe(true);
    expect(jsContent[0].text).toContain(HTTP_HIGH_RISK_TOOLS_FLAG);
    expect(jsContent[0].text).toContain(`${HTTP_HIGH_RISK_TOOLS_ENV}=1`);
    expect(calls).toEqual([]);

    const auth = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'auth_save', arguments: { site: 'example.test' } },
    }, { transport: 'http', sessionId: 'http-session' });

    const authResult = auth?.result as Record<string, unknown>;
    expect(authResult.isError).toBe(true);
  });

  test('HTTP allows high-risk tools with capability and audits redacted arguments', async () => {
    const server = new MCPServer();
    registerHighRiskFixtures(server);

    enableHttpHighRiskTools(server);
    const res = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'javascript',
        arguments: {
          expression: 'document.querySelector("button")?.textContent',
          text: 'ordinary text is kept',
          value: 'ordinary value is kept',
          password: 'secret-password',
          accessToken: 'secret-token',
          authorization: 'Bearer secret-auth',
          sessionId: 'secret-session',
          nested: {
            cookieValue: 'sid=secret-cookie',
            safe: 'kept',
          },
        },
      },
    }, { transport: 'http', sessionId: 'audit-session' });

    const result = res?.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe('executed');

    expect(auditLines).toHaveLength(1);
    const audit = JSON.parse(auditLines[0]) as Record<string, unknown>;
    expect(audit.tool).toBe('javascript');
    expect(audit.sessionId).toBe('audit-session');
    expect(audit.status).toBe('allowed');
    const summary = JSON.parse(audit.args_summary as string) as Record<string, unknown>;
    expect(summary.expression).toBe('document.querySelector("button")?.textContent');
    expect(summary.text).toBe('ordinary text is kept');
    expect(summary.value).toBe('ordinary value is kept');
    expect(summary.password).toBe('[REDACTED]');
    expect(summary.accessToken).toBe('[REDACTED]');
    expect(summary.authorization).toBe('[REDACTED]');
    expect(summary.sessionId).toBe('[REDACTED]');
    expect((summary.nested as Record<string, unknown>).cookieValue).toBe('[REDACTED]');
    expect((summary.nested as Record<string, unknown>).safe).toBe('kept');
    expect(auditLines[0]).not.toContain('secret-password');
    expect(auditLines[0]).not.toContain('secret-token');
    expect(auditLines[0]).not.toContain('secret-auth');
    expect(auditLines[0]).not.toContain('secret-session');
    expect(auditLines[0]).not.toContain('secret-cookie');
  });

  test('stdio context preserves high-risk tool availability without HTTP capability', async () => {
    const server = new MCPServer();
    registerHighRiskFixtures(server);
    server.setTier(3);

    const listResponse = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/list',
      params: {},
    }, { transport: 'stdio' });

    const listResult = listResponse?.result as Record<string, unknown>;
    const tools = listResult.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('javascript');
    expect(names).toContain('auth_save');

    const response = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'javascript', arguments: { expression: '1 + 1' } },
    }, { transport: 'stdio' });

    const result = response?.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe('executed');
    expect(auditLines).toHaveLength(0);
  });
});
