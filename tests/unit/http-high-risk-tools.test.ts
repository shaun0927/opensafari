import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { MCPServer } from '../../src/mcp-server';
import { HTTP_HIGH_RISK_TOOLS_ENV, HTTP_HIGH_RISK_TOOLS_FLAG } from '../../src/security/high-risk-tools';
import { MCPMessageContext, MCPResponse } from '../../src/types/mcp';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function mcpPost(
  port: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ body: Record<string, unknown>; status?: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          resolve({ body: JSON.parse(buf), status: res.statusCode, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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

  test('HTTP blocks code execution and auth movement tools without the capability', async () => {
    const server = new MCPServer();
    const port = await getFreePort();
    const calls: string[] = [];
    registerHighRiskFixtures(server, calls);

    await server.start({ transport: 'http', port, httpInsecure: true });
    try {
      const js = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'javascript', arguments: { expression: 'document.cookie' } },
      }, { 'Mcp-Session-Id': 'http-session' });

      const jsResult = js.body.result as Record<string, unknown>;
      const jsContent = jsResult.content as Array<Record<string, unknown>>;
      expect(jsResult.isError).toBe(true);
      expect(jsContent[0].text).toContain(HTTP_HIGH_RISK_TOOLS_FLAG);
      expect(jsContent[0].text).toContain(`${HTTP_HIGH_RISK_TOOLS_ENV}=1`);
      expect(calls).toEqual([]);

      const auth = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'auth_save', arguments: { site: 'example.test' } },
      }, { 'Mcp-Session-Id': 'http-session' });

      const authResult = auth.body.result as Record<string, unknown>;
      expect(authResult.isError).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('HTTP allows high-risk tools with capability and audits redacted arguments', async () => {
    const server = new MCPServer();
    const port = await getFreePort();
    registerHighRiskFixtures(server);

    await server.start({
      transport: 'http',
      port,
      httpInsecure: true,
      httpHighRiskTools: true,
    });
    try {
      const res = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'javascript',
          arguments: {
            expression: 'document.cookie',
            nested: {
              cookieValue: 'sid=secret-cookie',
              safe: 'kept',
            },
          },
        },
      }, { 'Mcp-Session-Id': 'audit-session' });

      const result = res.body.result as Record<string, unknown>;
      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0].text).toBe('executed');

      expect(auditLines).toHaveLength(1);
      const audit = JSON.parse(auditLines[0]) as Record<string, unknown>;
      expect(audit.tool).toBe('javascript');
      expect(audit.sessionId).toBe('audit-session');
      expect(audit.status).toBe('allowed');
      const summary = JSON.parse(audit.args_summary as string) as Record<string, unknown>;
      expect(summary.expression).toBe('[REDACTED]');
      expect((summary.nested as Record<string, unknown>).cookieValue).toBe('[REDACTED]');
      expect((summary.nested as Record<string, unknown>).safe).toBe('kept');
      expect(auditLines[0]).not.toContain('document.cookie');
      expect(auditLines[0]).not.toContain('secret-cookie');
    } finally {
      await server.stop();
    }
  });

  test('stdio context preserves high-risk tool availability without HTTP capability', async () => {
    const server = new MCPServer();
    registerHighRiskFixtures(server);

    const response = await (server as unknown as {
      handleMessage: (
        msg: Record<string, unknown>,
        context?: MCPMessageContext,
      ) => Promise<MCPResponse | null>;
    }).handleMessage({
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
