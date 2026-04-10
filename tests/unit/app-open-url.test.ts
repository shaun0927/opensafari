import { MCPServer } from '../../src/mcp-server';
import { registerAppOpenUrlTool } from '../../src/tools/app-open-url';

// Mock SimctlExecutor
jest.mock('../../src/simulator/simctl', () => {
  const execMock = jest.fn().mockResolvedValue('');
  return {
    SimctlExecutor: jest.fn().mockImplementation(() => ({
      exec: execMock,
    })),
    __execMock: execMock,
  };
});

// Mock SessionManager (used by resolveDeviceId)
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

function getExecMock(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../src/simulator/simctl').__execMock;
}

describe('app_open_url tool', () => {
  let server: MCPServer;
  let execMock: jest.Mock;

  beforeAll(() => {
    server = new MCPServer();
    registerAppOpenUrlTool(server);
  });

  beforeEach(() => {
    execMock = getExecMock();
    execMock.mockReset();
    execMock.mockResolvedValue('');
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_open_url');
  });

  test('opens a standard https URL', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'https://example.com/path' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.url).toBe('https://example.com/path');
    expect(text.deviceId).toBe('TEST-UDID-1234');
    expect(text.openedAt).toBeDefined();
    expect(execMock).toHaveBeenCalledWith(['openurl', 'TEST-UDID-1234', 'https://example.com/path']);
  });

  test('opens a custom URL scheme', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'myapp://deep/link' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.url).toBe('myapp://deep/link');
  });

  test('opens maps:// scheme', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'maps://q=Tokyo' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.url).toBe('maps://q=Tokyo');
  });

  test('returns error when url is missing', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
  });

  test('returns error when no device available', async () => {
    const sessionMgr = jest.requireMock('../../src/session-manager') as { getSessionManager: jest.Mock };
    sessionMgr.getSessionManager.mockReturnValueOnce({
      getSoleDeviceId: jest.fn().mockReturnValue(null),
    });

    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'https://example.com' });
    expect(result.isError).toBe(true);
  });
});
