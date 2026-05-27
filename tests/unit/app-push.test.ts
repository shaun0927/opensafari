import { MCPServer } from '../../src/mcp-server';
import { registerAppPushTool } from '../../src/tools/app-push';
import { SimulatorManager } from '../../src/simulator';
import { getSessionManager } from '../../src/session-manager';

const mockExec = jest.fn().mockResolvedValue('');

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockExec,
  })),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

// Mock fs for temp file operations
jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const mockedGetSessionManager = getSessionManager as jest.MockedFunction<typeof getSessionManager>;
const MockedSimulatorManager = SimulatorManager as jest.MockedClass<typeof SimulatorManager>;

describe('app_push tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppPushTool(server);
  });

  beforeEach(() => {
    mockExec.mockClear();
  });

  test('is registered', () => {
    expect(server.getRegisteredTools()).toContain('app_push');
  });

  test('pushes a notification', async () => {
    const handler = server.getToolHandler('app_push')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      payload: { aps: { alert: 'Hello World' } },
    });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.pushed).toBe(true);
    expect(text.bundleId).toBe('com.example.app');
    expect(mockExec).toHaveBeenCalledWith(
      expect.arrayContaining(['push', 'TEST-UDID-1234', 'com.example.app']),
    );
  });

  test('pushes notification with badge and sound', async () => {
    const handler = server.getToolHandler('app_push')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      payload: { aps: { alert: { title: 'Title', body: 'Body' }, badge: 1, sound: 'default' } },
    });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.pushed).toBe(true);
  });

  test('returns error when no device booted', async () => {
    mockedGetSessionManager.mockReturnValueOnce({ getSoleDeviceId: () => null } as ReturnType<typeof getSessionManager>);
    MockedSimulatorManager.mockImplementationOnce(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
    }) as unknown as SimulatorManager);

    const handler = server.getToolHandler('app_push')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      payload: { aps: { alert: 'Hello' } },
    });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('DEVICE_NOT_BOOTED');
  });

  test('returns error for invalid payload', async () => {
    const handler = server.getToolHandler('app_push')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      payload: 'not-an-object',
    });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('INVALID_INPUT');
  });
});
