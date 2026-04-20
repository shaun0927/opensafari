import { MCPServer } from '../../src/mcp-server';
import { registerAppSwitchAppTool } from '../../src/tools/app-switch-app';
import { SimulatorManager } from '../../src/simulator';
import { getSessionManager } from '../../src/session-manager';
import { probeMobileContext } from '../../src/tools/app-context';

const mockLaunchApp = jest.fn().mockResolvedValue({ pid: 12345, bundleId: 'com.apple.mobilesafari', deviceId: 'TEST-UDID-1234' });
const mockOpenUrl = jest.fn().mockResolvedValue(undefined);
const mockProbeMobileContext = jest.fn().mockResolvedValue({
  deviceId: 'TEST-UDID-1234',
  surface: 'app_content',
  contextVerified: true,
  expectedBundle: 'com.apple.mobilesafari',
  expectedBundleMatch: 'matched',
  expectedBundleMatchConfidence: 'verified',
  reason: 'ok',
  warnings: [],
  runningApps: [{ bundleId: 'com.apple.mobilesafari', pid: 12345 }],
  visibleSummary: { buttonLabels: [], staticTexts: [], textFieldLabels: [], nodeCount: 6 },
});

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
    launchApp: mockLaunchApp,
    openUrl: mockOpenUrl,
  })),
}));

jest.mock('../../src/tools/app-context', () => ({
  probeMobileContext: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

const MockedSimulatorManager = jest.mocked(SimulatorManager);
const mockedGetSessionManager = jest.mocked(getSessionManager);
const mockedProbeMobileContext = jest.mocked(probeMobileContext);

describe('app_switch_app tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppSwitchAppTool(server);
  });

  beforeEach(() => {
    mockLaunchApp.mockClear();
    mockOpenUrl.mockClear();
    mockedProbeMobileContext.mockReset();
    mockedProbeMobileContext.mockImplementation(mockProbeMobileContext);
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
    expect(text.context.expectedBundleMatch).toBe('matched');
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
    expect(text.context.expectedBundleMatch).toBe('matched');
    expect(mockOpenUrl).toHaveBeenCalledWith('TEST-UDID-1234', 'https://example.com/deep-link');
    expect(mockLaunchApp).not.toHaveBeenCalled();
  });


  test('returns explicit mismatch error when launched app is not foreground', async () => {
    mockedProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'TEST-UDID-1234',
      surface: 'simulator_chrome',
      contextVerified: true,
      expectedBundle: 'com.apple.mobilesafari',
      expectedBundleMatch: 'mismatch',
      expectedBundleMatchConfidence: 'verified',
      reason: 'chrome',
      warnings: ['not foreground'],
      runningApps: [],
      visibleSummary: { buttonLabels: ['Home'], staticTexts: [], textFieldLabels: [], nodeCount: 10 },
    });

    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', { bundleId: 'com.apple.mobilesafari' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('EXPECTED_BUNDLE_MISMATCH');
    expect(text.context.surface).toBe('simulator_chrome');
  });

  test('returns success with warning when launched app context is unknown', async () => {
    mockedProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'TEST-UDID-1234',
      surface: 'app_content',
      contextVerified: false,
      expectedBundle: 'com.apple.mobilesafari',
      expectedBundleMatch: 'unknown',
      expectedBundleMatchConfidence: 'unknown',
      reason: 'ambiguous',
      warnings: ['ambiguous foreground'],
      runningApps: [
        { bundleId: 'com.apple.mobilesafari', pid: 12345 },
        { bundleId: 'com.example.other', pid: 67890 },
      ],
      visibleSummary: { buttonLabels: [], staticTexts: [], textFieldLabels: [], nodeCount: 6 },
    });

    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', { bundleId: 'com.apple.mobilesafari' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.switched).toBe(true);
    expect(text.warning).toMatch(/could not be verified with confidence/);
  });

  test('returns success with warning when switch context probe fails', async () => {
    mockedProbeMobileContext.mockRejectedValueOnce(new Error('AX timeout'));

    const handler = server.getToolHandler('app_switch_app')!;
    const result = await handler('test', { bundleId: 'com.apple.mobilesafari' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.switched).toBe(true);
    expect(text.warning).toMatch(/Foreground context probe failed/);
    expect(text.context).toBeUndefined();
  });

  test('returns error when no device booted', async () => {
    mockedGetSessionManager.mockReturnValueOnce({ getSoleDeviceId: () => null } as ReturnType<typeof getSessionManager>);
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
