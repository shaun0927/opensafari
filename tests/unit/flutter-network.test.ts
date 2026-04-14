/**
 * Unit tests for flutter_network tool (proxy-based HTTP capture).
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

const mockExec = jest.fn().mockResolvedValue('');

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockExec,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

import * as net from 'net';
import { MCPServer } from '../../src/mcp-server';
import { registerFlutterNetworkTool } from '../../src/tools/flutter-network';

type ToolHandler = (s: string, p: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let handler: ToolHandler;

beforeAll(() => {
  const server = { registerTool: jest.fn() };
  registerFlutterNetworkTool(server as unknown as MCPServer);
  handler = (server.registerTool as jest.Mock).mock.calls[0][1];
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('flutter_network', () => {
  it('returns error when getting log without active proxy', async () => {
    const result = await handler('s', { action: 'log' });
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('No proxy running');
  });

  it('returns not_running when stopping without active proxy', async () => {
    const result = await handler('s', { action: 'stop' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('not_running');
  });

  it('starts proxy on specified port', async () => {
    const result = await handler('s', { action: 'start', port: 18888 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('started');
    expect(body.port).toBe(18888);

    // Clean up
    await handler('s', { action: 'stop' });
  });

  it('returns empty log when no traffic captured', async () => {
    await handler('s', { action: 'start', port: 18889 });

    const result = await handler('s', { action: 'log' });
    const body = JSON.parse(result.content[0].text);

    expect(body.total).toBe(0);
    expect(body.entries).toEqual([]);

    await handler('s', { action: 'stop' });
  });

  it('exports empty HAR format', async () => {
    await handler('s', { action: 'start', port: 18890 });

    const result = await handler('s', { action: 'har' });
    const body = JSON.parse(result.content[0].text);

    expect(body.log).toBeDefined();
    expect(body.log.version).toBe('1.2');
    expect(body.log.creator.name).toBe('opensafari');
    expect(body.log.entries).toEqual([]);

    await handler('s', { action: 'stop' });
  });

  it('stops proxy and reports entries captured', async () => {
    await handler('s', { action: 'start', port: 18891 });

    const result = await handler('s', { action: 'stop' });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('stopped');
    expect(body.entries_captured).toBe(0);
  });

  it('prevents starting duplicate proxy', async () => {
    await handler('s', { action: 'start', port: 18892 });

    const result = await handler('s', { action: 'start', port: 18893 });
    const body = JSON.parse(result.content[0].text);

    expect(body.error).toContain('already running');

    await handler('s', { action: 'stop' });
  });

  it('accepts throttle_ms on start', async () => {
    const result = await handler('s', { action: 'start', port: 18900, throttle_ms: 150 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('started');
    expect(body.throttle_ms).toBe(150);

    await handler('s', { action: 'stop' });
  });

  it('rejects negative throttle_ms', async () => {
    const result = await handler('s', { action: 'start', port: 18901, throttle_ms: -5 });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/throttle_ms|negative/i);
  });

  it('updates throttle via throttle action', async () => {
    await handler('s', { action: 'start', port: 18902 });

    const result = await handler('s', { action: 'throttle', throttle_ms: 250 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('updated');
    expect(body.throttle_ms).toBe(250);

    await handler('s', { action: 'stop' });
  });

  it('returns error when throttle action called without proxy', async () => {
    const result = await handler('s', { action: 'throttle', throttle_ms: 100 });
    const body = JSON.parse(result.content[0].text);

    expect(body.error).toMatch(/No proxy/i);
  });

  it('captures WebSocket upgrade requests as entries with is_upgrade=true', async () => {
    // Spin up a local TCP server that responds to upgrade with 101
    const upstream = await new Promise<net.Server>((resolve) => {
      const srv = net.createServer((sock) => {
        sock.once('data', () => {
          sock.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
          );
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });

    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    try {
      await handler('s', { action: 'start', port: 18894 });

      // Open raw TCP to the proxy and send a WebSocket upgrade request
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection(18894, '127.0.0.1', () => {
          const req = [
            `GET http://127.0.0.1:${upstreamPort}/ws HTTP/1.1`,
            `Host: 127.0.0.1:${upstreamPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n');
          client.write(req);
        });

        client.once('data', () => {
          client.destroy();
          resolve();
        });

        client.on('error', reject);
        setTimeout(() => { client.destroy(); resolve(); }, 5000);
      });

      // Wait for async addEntry to run
      await new Promise((r) => setTimeout(r, 200));

      const logResult = await handler('s', { action: 'log' });
      const logBody = JSON.parse(logResult.content[0].text);

      const upgradeEntry = logBody.entries.find(
        (e: Record<string, unknown>) => e.is_upgrade === true,
      );

      expect(upgradeEntry).toBeDefined();
      expect(upgradeEntry.status).toBe(101);
      expect(upgradeEntry.method).toBe('GET');
    } finally {
      await handler('s', { action: 'stop' });
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 15000);
});
