import { MCPServer } from '../../src/mcp-server';
import { registerAppActivateTool } from '../../src/tools/app-activate';
import { SimulatorManager } from '../../src/simulator';
import { getSessionManager } from '../../src/session-manager';
import { probeMobileContext } from '../../src/tools/app-context';

const mockActivateApp = jest.fn().mockResolvedValue({
  activated: true,
  bundleId: 'com.example.app',
  deviceId: 'TEST-UDID-1234',
  pid: 12345,
});
const mockProbeMobileContext = jest.fn().mockResolvedValue({
  deviceId: 'TEST-UDID-1234',
  surface: 'app_content',
  contextVerified: true,
  expectedBundle: 'com.example.app',
  expectedBundleMatch: 'matched',
  expectedBundleMatchConfidence: 'verified',
  reason: 'ok',
  warnings: [],
  runningApps: [{ bundleId: 'com.example.app', pid: 12345 }],
  visibleSummary: { buttonLabels: [], staticTexts: [], textFieldLabels: [], nodeCount: 6 },
});

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
    activateApp: mockActivateApp,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

jest.mock('../../src/tools/app-context', () => ({
  probeMobileContext: jest.fn(),
}));

const MockedSimulatorManager = jest.mocked(SimulatorManager);
const mockedGetSessionManager = jest.mocked(getSessionManager);
const mockedProbeMobileContext = jest.mocked(probeMobileContext);

describe('app_activate tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppActivateTool(server);
  });

  beforeEach(() => {
    mockActivateApp.mockClear();
    mockedProbeMobileContext.mockReset();
    mockedProbeMobileContext.mockImplementation(mockProbeMobileContext);
  });

  test('returns activated app plus verified context', async () => {
    const handler = server.getToolHandler('app_activate')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.activated).toBe(true);
    expect(text.context.expectedBundleMatch).toBe('matched');
    expect(mockActivateApp).toHaveBeenCalledWith('TEST-UDID-1234', 'com.example.app');
  });

  test('returns explicit mismatch error when app is not foreground after activation', async () => {
    mockedProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'TEST-UDID-1234',
      surface: 'simulator_chrome',
      contextVerified: true,
      expectedBundle: 'com.example.app',
      expectedBundleMatch: 'mismatch',
      expectedBundleMatchConfidence: 'verified',
      reason: 'chrome',
      warnings: ['not foreground'],
      runningApps: [],
      visibleSummary: { buttonLabels: ['Home'], staticTexts: [], textFieldLabels: [], nodeCount: 10 },
    });

    const handler = server.getToolHandler('app_activate')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('EXPECTED_BUNDLE_MISMATCH');
    expect(text.context.surface).toBe('simulator_chrome');
  });

  test('returns success with warning when context is unknown', async () => {
    mockedProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'TEST-UDID-1234',
      surface: 'app_content',
      contextVerified: false,
      expectedBundle: 'com.example.app',
      expectedBundleMatch: 'unknown',
      expectedBundleMatchConfidence: 'unknown',
      reason: 'ambiguous',
      warnings: ['ambiguous foreground'],
      runningApps: [{ bundleId: 'com.example.app', pid: 12345 }, { bundleId: 'com.apple.mobilesafari', pid: 678 }],
      visibleSummary: { buttonLabels: [], staticTexts: [], textFieldLabels: [], nodeCount: 10 },
    });

    const handler = server.getToolHandler('app_activate')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.activated).toBe(true);
    expect(text.warning).toMatch(/could not be verified with confidence/);
  });

  test('returns success with warning when context probe fails', async () => {
    mockedProbeMobileContext.mockRejectedValueOnce(new Error('AX timeout'));

    const handler = server.getToolHandler('app_activate')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.activated).toBe(true);
    expect(text.warning).toMatch(/Foreground context probe failed/);
    expect(text.context).toBeUndefined();
  });

  test('returns error when no device booted', async () => {
    mockedGetSessionManager.mockReturnValueOnce({ getSoleDeviceId: () => null } as ReturnType<typeof getSessionManager>);
    MockedSimulatorManager.mockImplementationOnce(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
      activateApp: mockActivateApp,
    }) as unknown as SimulatorManager);

    const handler = server.getToolHandler('app_activate')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    expect(result.isError).toBe(true);
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.error).toBe('DEVICE_NOT_BOOTED');
  });
});
