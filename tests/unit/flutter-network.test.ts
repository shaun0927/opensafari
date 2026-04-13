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
});
