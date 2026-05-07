import http from 'http';
import type { AddressInfo } from 'net';
import { MCPServer } from '../../src/mcp-server';
import { HTTPTransport } from '../../src/transports/http';

type ResponseShape = {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
  json?: Record<string, unknown>;
};

const TOKEN = 'test-token-697';
let port: number;
const LOOPBACK_PORT = 0;

function request(options: http.RequestOptions, body?: Record<string, unknown>): Promise<ResponseShape> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        ...options,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => (buf += chunk.toString('utf8')));
        res.on('end', () => {
          let json: Record<string, unknown> | undefined;
          try {
            json = buf ? JSON.parse(buf) as Record<string, unknown> : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

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

function mcpRequest(method: string, headers: Record<string, string> = {}, body?: Record<string, unknown>): Promise<ResponseShape> {
  return request({ hostname: '127.0.0.1', port, path: '/mcp', method, headers }, body);
}

describe('HTTP transport security defaults', () => {
  describe('loopback bind default', () => {
    let transport: HTTPTransport;

    afterEach(async () => {
      if (transport) await transport.close();
    });

    test('listens on loopback by default', async () => {
      transport = new HTTPTransport(LOOPBACK_PORT, { insecure: true });
      transport.start();

      let address = transport.getAddress() as AddressInfo | null;
      for (let i = 0; i < 50 && address === null; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        address = transport.getAddress() as AddressInfo | null;
      }

      expect(address?.address).toBe('127.0.0.1');
    });
  });

  describe('/mcp auth and CORS', () => {
    let server: MCPServer;

    beforeAll(async () => {
      port = await getFreePort();
      server = new MCPServer();
      server.registerTool(
        { name: 'echo', description: 'Echo input', inputSchema: { type: 'object' as const, properties: { msg: { type: 'string' } }, required: ['msg'] } },
        async (_sid: string, params: Record<string, unknown>) => ({
          content: [{ type: 'text' as const, text: String(params.msg) }],
        }),
      );
      server.setTier(3);
      await server.start({
        transport: 'http',
        port,
        authToken: TOKEN,
        allowedOrigins: ['https://ci.example.test'],
      });
    });

    afterAll(async () => {
      await server.stop();
    });

    test.each(['POST', 'GET', 'DELETE'])('rejects tokenless %s /mcp requests', async (method) => {
      const res = await mcpRequest(method, {}, method === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } : undefined);

      expect(res.status).toBe(401);
      expect(res.json).toHaveProperty('error');
    });

    test('rejects invalid bearer token', async () => {
      const res = await mcpRequest('POST', { Authorization: 'Bearer wrong-token' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(res.status).toBe(401);
    });

    test('accepts valid bearer token and preserves MCP initialize response', async () => {
      const res = await mcpRequest('POST', { Authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(res.status).toBe(200);
      expect(res.json).toHaveProperty('result');
      expect((res.json!.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    test('allows local browser origins without wildcard CORS', async () => {
      const res = await mcpRequest('OPTIONS', {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    });

    test('allows explicitly configured CORS origins', async () => {
      const res = await mcpRequest('OPTIONS', {
        Origin: 'https://ci.example.test',
        'Access-Control-Request-Method': 'POST',
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://ci.example.test');
    });

    test('rejects disallowed browser origins before /mcp handling', async () => {
      const res = await mcpRequest('OPTIONS', {
        Origin: 'https://evil.example.test',
        'Access-Control-Request-Method': 'POST',
      });

      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
