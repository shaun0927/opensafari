import { MCPServer } from '../../src/mcp-server';
import { registerAppSwitchAppTool } from '../../src/tools/app-switch-app';
import { SimulatorManager } from '../../src/simulator';
import { getSessionManager } from '../../src/session-manager';

const mockLaunchApp = jest.fn().mockResolvedValue({ pid: 12345, bundleId: 'com.apple.mobilesafari', deviceId: 'TEST-UDID-1234' });
const mockOpenUrl = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
    launchApp: mockLaunchApp,
    openUrl: mockOpenUrl,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getActiveDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

const MockedSimulatorManager = jest.mocked(SimulatorManager);
const mockedGetSessionManager = jest.mocked(getSessionManager);

describe('app_switch_app tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppSwitchAppTool(server);
  });

  beforeEach(() => {
    mockLaunchApp.mockClear();
    mockOpenUrl.mockClear();
  });

  test('is registered', () => {
    expect(server.getRegisteredTools()).toContain('app_switch_app');
  });

  test('switches to app by bundle ID', async () => {
    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', { bundleId: 'com.apple.mobilesafari' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.switched).toBe(true);
    expect(text.bundleId).toBe('com.apple.mobilesafari');
    expect(text.pid).toBe(12345);
    expect(mockLaunchApp).toHaveBeenCalledWith('TEST-UDID-1234', 'com.apple.mobilesafari');
  });

  test('switches to app with URL for handoff', async () => {
    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      url: 'https://example.com/deep-link',
    });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.switched).toBe(true);
    expect(text.url).toBe('https://example.com/deep-link');
    expect(mockOpenUrl).toHaveBeenCalledWith('TEST-UDID-1234', 'https://example.com/deep-link');
    expect(mockLaunchApp).not.toHaveBeenCalled();
  });

  test('returns error when no device booted', async () => {
    mockedGetSessionManager.mockReturnValueOnce({ getActiveDeviceId: () => null } as ReturnType<typeof getSessionManager>);
    MockedSimulatorManager.mockImplementationOnce(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
      launchApp: mockLaunchApp,
      openUrl: mockOpenUrl,
    }) as unknown as SimulatorManager);

    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', { bundleId: 'com.apple.mobilesafari' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('DEVICE_NOT_BOOTED');
  });

  test('uses custom scheme URL', async () => {
    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', {
      bundleId: 'com.example.app',
      url: 'myapp://settings/profile',
    });
    expect(result.isError).toBeUndefined();
    expect(mockOpenUrl).toHaveBeenCalledWith('TEST-UDID-1234', 'myapp://settings/profile');
  });
});
