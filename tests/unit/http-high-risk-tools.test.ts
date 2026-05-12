import fs from 'fs';
import { MCPServer } from '../../src/mcp-server';
import {
  HIGH_RISK_MCP_TOOLS,
  HTTP_HIGH_RISK_TOOLS_ENV,
  HTTP_HIGH_RISK_TOOLS_FLAG,
  getHighRiskToolMetadata,
} from '../../src/security/high-risk-tools';
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
    appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(((_path, data) => {
      auditLines.push(String(data));
    }) as typeof fs.appendFileSync);
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
          text: 'secret typed text',
          value: 'secret selected value',
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
    expect(summary.text).toBe('[REDACTED]');
    expect(summary.value).toBe('[REDACTED]');
    expect(summary.password).toBe('[REDACTED]');
    expect(summary.accessToken).toBe('[REDACTED]');
    expect(summary.authorization).toBe('[REDACTED]');
    expect(summary.sessionId).toBe('[REDACTED]');
    expect((summary.nested as Record<string, unknown>).cookieValue).toBe('[REDACTED]');
    expect((summary.nested as Record<string, unknown>).safe).toBe('kept');
    expect(auditLines[0]).not.toContain('secret-password');
    expect(auditLines[0]).not.toContain('secret typed text');
    expect(auditLines[0]).not.toContain('secret selected value');
    expect(auditLines[0]).not.toContain('secret-token');
    expect(auditLines[0]).not.toContain('secret-auth');
    expect(auditLines[0]).not.toContain('secret-session');
    expect(auditLines[0]).not.toContain('secret-cookie');
  });

  test('HTTP audit status is error when a high-risk tool returns isError', async () => {
    const server = new MCPServer();
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
      async () => ({
        isError: true,
        content: [{ type: 'text' as const, text: 'execution failed' }],
      }),
    );

    enableHttpHighRiskTools(server);
    const res = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'javascript',
        arguments: { expression: 'throw new Error("boom")' },
      },
    }, { transport: 'http', sessionId: 'audit-error-session' });

    const result = res?.result as Record<string, unknown>;
    expect(result.isError).toBe(true);

    expect(auditLines).toHaveLength(1);
    const audit = JSON.parse(auditLines[0]) as Record<string, unknown>;
    expect(audit.tool).toBe('javascript');
    expect(audit.sessionId).toBe('audit-error-session');
    expect(audit.status).toBe('error');
  });

  test('HTTP audit log redacts the cookies tool arguments including nested cookie values', async () => {
    const server = new MCPServer();
    server.registerTool(
      {
        name: 'cookies',
        description: 'fixture cookies tool',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string' },
            cookies: { type: 'array' },
            domain: { type: 'string' },
          },
        },
      },
      async () => ({ content: [{ type: 'text' as const, text: 'cookies set' }] }),
    );
    enableHttpHighRiskTools(server);

    await handleMessage(server, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'cookies',
        arguments: {
          action: 'set',
          cookies: [
            { name: 'sid', value: 'super-secret-session', domain: 'example.com', path: '/' },
            { name: 'auth_token', value: 'super-secret-auth', domain: '.example.com' },
          ],
          domain: 'example.com',
        },
      },
    }, { transport: 'http', sessionId: 'cookie-audit' });

    expect(auditLines).toHaveLength(1);
    const audit = JSON.parse(auditLines[0]) as Record<string, unknown>;
    expect(audit.tool).toBe('cookies');
    expect(audit.status).toBe('allowed');
    const summary = JSON.parse(audit.args_summary as string) as Record<string, unknown>;
    expect(summary.action).toBe('set');
    expect(summary.cookies).toBe('[REDACTED]');
    expect(summary.domain).toBe('example.com');
    expect(auditLines[0]).not.toContain('super-secret-session');
    expect(auditLines[0]).not.toContain('super-secret-auth');
  });

  test.each([
    'batch_execute',
    'flutter_call_service_extension',
    'run_scenario',
    'assert_all_devices',
    'mock_geolocation',
  ])('HTTP gates code-execution tool %s without the capability', async (toolName) => {
    expect(getHighRiskToolMetadata(toolName)).toEqual({
      category: 'code-execution',
      requiredCapability: 'http-high-risk-tools',
    });

    const server = new MCPServer();
    const calls: string[] = [];
    server.registerTool(
      {
        name: toolName,
        description: `fixture for ${toolName}`,
        inputSchema: {
          type: 'object' as const,
          properties: { expression: { type: 'string' } },
        },
      },
      async (_sessionId, params) => {
        calls.push(JSON.stringify(params));
        return { content: [{ type: 'text' as const, text: 'executed' }] };
      },
    );
    server.setTier(3);

    const blocked = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: toolName, arguments: { expression: 'document.cookie' } },
    }, { transport: 'http', sessionId: 'gate-session' });

    const blockedResult = blocked?.result as Record<string, unknown>;
    const blockedContent = blockedResult.content as Array<Record<string, unknown>>;
    expect(blockedResult.isError).toBe(true);
    expect(blockedContent[0].text).toContain(HTTP_HIGH_RISK_TOOLS_FLAG);
    expect(blockedContent[0].text).toContain(`${HTTP_HIGH_RISK_TOOLS_ENV}=1`);
    expect(calls).toEqual([]);

    const listResponse = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/list',
      params: {},
    }, { transport: 'http', sessionId: 'gate-session' });

    const listResult = listResponse?.result as Record<string, unknown>;
    const tools = listResult.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).not.toContain(toolName);

    enableHttpHighRiskTools(server);
    const allowed = await handleMessage(server, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: toolName, arguments: { expression: '1 + 1' } },
    }, { transport: 'http', sessionId: 'gate-session' });

    const allowedResult = allowed?.result as Record<string, unknown>;
    const allowedContent = allowedResult.content as Array<Record<string, unknown>>;
    expect(allowedContent[0].text).toBe('executed');
    expect(calls).toHaveLength(1);
  });

  test('high-risk denylist still covers the originally hardened code/credential tools', () => {
    for (const expectedTool of [
      'javascript',
      'flutter_evaluate',
      'auth_save',
      'auth_restore',
      'cookies',
    ]) {
      expect(HIGH_RISK_MCP_TOOLS[expectedTool]).toBeDefined();
    }
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
