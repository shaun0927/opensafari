import http from 'http';
import { MCPServer } from '../../src/mcp-server';
import { toolRegistry, defineToolEntry } from '../../src/tools/registry';
import * as auditLogger from '../../src/security/audit-logger';

// Helper: send a JSON-RPC request to the MCP HTTP server
function mcpPost(
  port: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ body: Record<string, unknown>; status?: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
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
          try {
            resolve({ body: JSON.parse(buf), status: res.statusCode, headers: res.headers });
          } catch {
            resolve({ body: { raw: buf }, status: res.statusCode, headers: res.headers });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('MCPServer — JSON-RPC protocol', () => {
  let server: MCPServer;
  const PORT = 19321; // unlikely to collide

  beforeAll(async () => {
    server = new MCPServer();
    // Register a simple echo tool for testing
    server.registerTool(
      { name: 'echo', description: 'Echo input', inputSchema: { type: 'object' as const, properties: { msg: { type: 'string' } }, required: ['msg'] } },
      async (_sid: string, params: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: String(params.msg) }],
      }),
    );
    // Register a tool that throws
    server.registerTool(
      { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' as const, properties: {}, required: [] } },
      async () => { throw new Error('intentional failure'); },
    );
    server.setTier(3);
    await server.start({ transport: 'http', port: PORT, httpInsecure: true });
  });

  afterAll(async () => {
    await server.stop();
  });

  // ── initialize ──

  test('initialize returns protocol version and server info', async () => {
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.body).toHaveProperty('result');
    const result = res.body.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect((result.serverInfo as Record<string, unknown>).name).toBe('opensafari-mcp');
  });

  test('initialize returns Mcp-Session-Id header in HTTP mode', async () => {
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 101, method: 'initialize', params: {} });

    expect(res.status).toBe(200);
    expect(typeof res.headers['mcp-session-id']).toBe('string');
    expect((res.headers['mcp-session-id'] as string).length).toBeGreaterThan(0);
  });

  // ── tools/list ──

  test('tools/list returns registered tools', async () => {
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const result = res.body.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('fail');
  });

  test('tools/list respects tier filtering', async () => {
    // Unrecognized tool names default to tier 2; setting tier to 0 should hide all
    server.setTier(0);
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const result = res.body.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(0);
    server.setTier(3); // restore
  });

  // ── tools/call ──

  test('tools/call routes to correct handler and returns result', async () => {
    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'hello' } },
    });
    const result = res.body.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe('hello');
  });

  test('tools/call with unknown tool returns INVALID_PARAMS', async () => {
    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });
    expect(res.body).toHaveProperty('error');
    const error = res.body.error as Record<string, unknown>;
    expect(error.message).toContain('Unknown tool');
  });

  test('tools/call without name returns INVALID_PARAMS', async () => {
    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { arguments: {} },
    });
    expect(res.body).toHaveProperty('error');
    const error = res.body.error as Record<string, unknown>;
    expect(error.message).toContain('requires params.name');
  });

  test('tools/call handler exception returns error result', async () => {
    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'fail', arguments: {} },
    });
    const result = res.body.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toContain('intentional failure');
  });

  // ── error cases ──

  test('unknown method returns METHOD_NOT_FOUND', async () => {
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 8, method: 'unknown/method', params: {} });
    expect(res.body).toHaveProperty('error');
    const error = res.body.error as Record<string, unknown>;
    expect(error.message).toContain('Method not found');
  });

  test('missing method with id returns INVALID_REQUEST', async () => {
    const res = await mcpPost(PORT, { jsonrpc: '2.0', id: 9 });
    expect(res.body).toHaveProperty('error');
    const error = res.body.error as Record<string, unknown>;
    expect(error.message).toContain('Missing method');
  });

  test('session survives initialize -> tools/list -> tools/call round trip', async () => {
    const init = await mcpPost(PORT, { jsonrpc: '2.0', id: 201, method: 'initialize', params: {} });
    const sessionId = init.headers['mcp-session-id'] as string;

    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const list = await mcpPost(
      PORT,
      { jsonrpc: '2.0', id: 202, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': sessionId },
    );
    const listTools = (list.body.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(listTools.length).toBeGreaterThan(0);

    const call = await mcpPost(
      PORT,
      {
        jsonrpc: '2.0',
        id: 203,
        method: 'tools/call',
        params: { name: 'echo', arguments: { msg: 'still-alive' } },
      },
      { 'Mcp-Session-Id': sessionId },
    );
    const content = ((call.body.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
    expect(content.text).toBe('still-alive');
  });

  test('notification (no id) returns 202 with no body', async () => {
    const res: Record<string, unknown> = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const req = http.request(
        { hostname: 'localhost', port: PORT, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
        (r) => {
          let buf = '';
          r.on('data', (c) => (buf += c));
          r.on('end', () => resolve({ status: r.statusCode, body: buf }));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(res.status).toBe(202);
  });

  // ── no-handler JSON-RPC error ──

  test('tools/call on tool without handler returns JSON-RPC INTERNAL_ERROR', async () => {
    // Inject a RegisteredTool entry with no handler and not in toolRegistry
    // by reaching into the server's internal tools map via a cast.
    const internalTools = (server as unknown as { tools: Map<string, unknown> }).tools;
    internalTools.set('__no_handler__', {
      definition: { name: '__no_handler__', description: 'no handler', inputSchema: { type: 'object', properties: {}, required: [] } },
      tier: 3,
      // handler intentionally omitted; lazy intentionally omitted
    });

    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 901, method: 'tools/call',
      params: { name: '__no_handler__', arguments: {} },
    });

    // Must be a top-level error, NOT result.isError
    expect(res.body).toHaveProperty('error');
    expect(res.body).not.toHaveProperty('result');
    const error = res.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32603); // INTERNAL_ERROR
    expect(String(error.message)).toContain('no handler registered for tool');

    internalTools.delete('__no_handler__');
  });

  // ── lazy-load failure returns JSON-RPC error ──

  test('tools/call on lazy tool whose loadHandler rejects returns JSON-RPC INTERNAL_ERROR (not isError result)', async () => {
    // Register a registry entry whose loadHandler always rejects
    const LAZY_FAIL = '__lazy_fail__';
    defineToolEntry(
      { name: LAZY_FAIL, description: 'lazy fail', inputSchema: { type: 'object' as const, properties: {}, required: [] } },
      () => Promise.reject(new Error('module not found')),
    );
    const internalTools = (server as unknown as { tools: Map<string, unknown> }).tools;
    internalTools.set(LAZY_FAIL, {
      definition: toolRegistry.get(LAZY_FAIL)!.definition,
      lazy: true,
      tier: 3,
    });

    const res = await mcpPost(PORT, {
      jsonrpc: '2.0', id: 910, method: 'tools/call',
      params: { name: LAZY_FAIL, arguments: {} },
    });

    // Must be a top-level JSON-RPC error, NOT result.isError
    expect(res.body).toHaveProperty('error');
    expect(res.body).not.toHaveProperty('result');
    const error = res.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32603); // INTERNAL_ERROR
    expect(String(error.message)).toContain('Failed to load');

    internalTools.delete(LAZY_FAIL);
    toolRegistry.delete(LAZY_FAIL);
  });

  test('tools/call on lazy tool whose loadHandler rejects logs an audit entry', async () => {
    const LAZY_AUDIT = '__lazy_audit__';
    defineToolEntry(
      { name: LAZY_AUDIT, description: 'lazy audit', inputSchema: { type: 'object' as const, properties: {}, required: [] } },
      () => Promise.reject(new Error('load failed')),
    );
    const internalTools = (server as unknown as { tools: Map<string, unknown> }).tools;
    internalTools.set(LAZY_AUDIT, {
      definition: toolRegistry.get(LAZY_AUDIT)!.definition,
      lazy: true,
      tier: 3,
    });

    const auditSpy = jest.spyOn(auditLogger, 'logAuditEntry').mockImplementation(() => undefined);
    server.enableAuditLog();

    await mcpPost(PORT, {
      jsonrpc: '2.0', id: 911, method: 'tools/call',
      params: { name: LAZY_AUDIT, arguments: {} },
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(LAZY_AUDIT, expect.any(String), expect.any(Object));

    auditSpy.mockRestore();
    internalTools.delete(LAZY_AUDIT);
    toolRegistry.delete(LAZY_AUDIT);
  });

  // ── registerLazyTool uses registry schema as source of truth ──

  test('registerLazyTool prefers registry schema over caller-provided definition when they differ', async () => {
    // Spin up a fresh server (not the shared HTTP one) to test registerLazyTool in isolation
    const freshServer = new MCPServer();
    const TOOL_NAME = '__schema_truth__';

    defineToolEntry(
      { name: TOOL_NAME, description: 'registry description', inputSchema: { type: 'object' as const, properties: { x: { type: 'string' } }, required: [] } },
      () => Promise.resolve(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    );

    // Call registerLazyTool with a DIFFERENT description — registry's should win
    freshServer.registerLazyTool({
      name: TOOL_NAME,
      description: 'caller description (should be ignored)',
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
    });
    freshServer.setTier(3);

    await freshServer.start({ transport: 'http', port: 19399, httpInsecure: true });
    const res = await mcpPost(19399, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    await freshServer.stop();

    const tools = (res.body.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    const entry = tools.find((t) => t.name === TOOL_NAME);
    expect(entry).toBeDefined();
    expect(entry!.description).toBe('registry description');

    toolRegistry.delete(TOOL_NAME);
  });

  // ── health endpoint ──

  test('GET /health returns ok status', async () => {
    const res: Record<string, unknown> = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/health`, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
      }).on('error', reject);
    });
    expect(res.status).toBe('ok');
    expect(res.transport).toBe('http');
  });
});
