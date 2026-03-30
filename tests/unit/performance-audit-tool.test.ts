import http from 'http';
import { MCPServer } from '../../src/mcp-server';

function mcpPost(port: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let buf = '';
        res.on('data', (chunk: string) => (buf += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf, status: res.statusCode }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('performance_audit tool registration', () => {
  let server: MCPServer;
  const PORT = 19340;

  beforeAll(async () => {
    server = new MCPServer();
    const { registerPerformanceAuditTool } = await import('../../src/tools/performance-audit');
    registerPerformanceAuditTool(server);
    server.setTier(3);
    await server.start({ transport: 'http', port: PORT });
  });

  afterAll(async () => {
    await server.stop();
  });

  test('performance_audit appears in tools/list', async () => {
    await mcpPost(PORT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('performance_audit');
  });

  test('performance_audit has correct input schema', async () => {
    await mcpPost(PORT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const result = res.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    const tool = result.tools.find((t) => t.name === 'performance_audit');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('runs');
    expect(props).toHaveProperty('waitAfterLoad');
    expect(schema.required).toEqual(['url']);
  });

  test('returns error when no Safari connected', async () => {
    await mcpPost(PORT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'performance_audit', arguments: { url: 'https://example.com' } },
    });
    const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Safari not connected/);
  });
});
