import { MCPServer } from '../../src/mcp-server';
import { registerAppOpenUrlTool } from '../../src/tools/app-open-url';

// Mock SimulatorManager
jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
    openUrl: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock SessionManager
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getActiveDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

describe('app_open_url tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppOpenUrlTool(server);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_open_url');
  });

  test('opens a standard https URL', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'https://example.com/path' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.opened).toBe(true);
    expect(text.url).toBe('https://example.com/path');
    expect(text.scheme).toBe('https');
  });

  test('opens a custom URL scheme', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'myapp://deep/link' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.opened).toBe(true);
    expect(text.scheme).toBe('myapp');
  });

  test('opens maps:// scheme', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'maps://q=Tokyo' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.scheme).toBe('maps');
  });

  test('rejects URL without scheme', async () => {
    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'example.com/no-scheme' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.error).toBe('INVALID_URL');
  });

  test('returns error when no device booted', async () => {
    // Override mocks for this test
    const sessionMgr = jest.requireMock('../../src/session-manager') as { getSessionManager: jest.Mock };
    const simMod = jest.requireMock('../../src/simulator') as { SimulatorManager: jest.Mock };
    sessionMgr.getSessionManager.mockReturnValueOnce({ getActiveDeviceId: () => null });
    simMod.SimulatorManager.mockImplementationOnce(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
      openUrl: jest.fn(),
    }));

    const handler = server.getToolHandler('app_open_url')!;
    const result = await handler('test', { url: 'https://example.com' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(text.error).toBe('DEVICE_NOT_BOOTED');
  });
});
