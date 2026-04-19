import { MCPServer } from '../../src/mcp-server';
import { registerAppTapTool } from '../../src/tools/app-tap';

const mockTap = jest.fn().mockResolvedValue(undefined);
const mockProbeMobileContext = jest.fn();

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simhid' as const,
    tap: mockTap,
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'TEST-UDID-1234',
  }),
}));

jest.mock('../../src/tools/app-context', () => ({
  probeMobileContext: (...args: unknown[]) => mockProbeMobileContext(...args),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({})),
}));

describe('app_tap tool', () => {
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;

  beforeAll(() => {
    const server = {
      registerTool: jest.fn((_schema: unknown, fn: unknown) => {
        handler = fn as typeof handler;
      }),
    } as unknown as MCPServer;
    registerAppTapTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProbeMobileContext.mockResolvedValue({
      deviceId: 'TEST-UDID-1234',
      surface: 'app_content',
      contextVerified: false,
      expectedBundle: 'com.example.target',
      expectedBundleMatch: 'matched',
      expectedBundleMatchConfidence: 'heuristic',
      reason: 'heuristic test',
      warnings: [],
      runningApps: [{ bundleId: 'com.example.target', pid: 123 }],
      visibleSummary: {
        buttonLabels: ['Continue'],
        staticTexts: ['Welcome'],
        textFieldLabels: [],
        nodeCount: 2,
      },
    });
  });

  test('returns postInputContext when verifyContext is enabled', async () => {
    const result = await handler('test', {
      x: 100,
      y: 200,
      verifyContext: true,
      settleMs: 0,
      expectedBundle: 'com.example.target',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('tapped');
    expect(body.postInputContext.surface).toBe('app_content');
    expect(body.warning).toBeUndefined();
    expect(mockProbeMobileContext).toHaveBeenCalledWith({
      deviceId: 'TEST-UDID-1234',
      expectedBundle: 'com.example.target',
      manager: expect.any(Object),
    });
  });

  test('adds warning when expected bundle is not matched', async () => {
    mockProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'TEST-UDID-1234',
      surface: 'springboard_like',
      contextVerified: true,
      inferredBundleId: 'com.apple.springboard',
      expectedBundle: 'com.example.target',
      expectedBundleMatch: 'mismatch',
      expectedBundleMatchConfidence: 'verified',
      reason: 'springboard',
      warnings: [],
      runningApps: [],
      visibleSummary: {
        buttonLabels: ['Safari'],
        staticTexts: [],
        textFieldLabels: [],
        nodeCount: 1,
      },
    });

    const result = await handler('test', {
      x: 100,
      y: 200,
      expectedBundle: 'com.example.target',
      settleMs: 0,
    });
    const body = JSON.parse(result.content[0].text);
    const warningMismatch = JSON.parse(body.warning);
    expect(warningMismatch.code).toBe('POST_TAP_CONTEXT_MISMATCH');
    expect(warningMismatch.message).toContain('Post-tap context did not confirm expected bundle');
  });

  test('returns tap success with warning when post-tap context probe throws', async () => {
    mockProbeMobileContext.mockRejectedValueOnce(new Error('AX bridge unavailable'));

    const result = await handler('test', {
      x: 100,
      y: 200,
      verifyContext: true,
      settleMs: 0,
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('tapped');
    const warningObj = JSON.parse(body.warning);
    expect(warningObj.code).toBe('POST_TAP_CONTEXT_PROBE_FAILED');
    expect(warningObj.reason).toBe('AX bridge unavailable');
    expect(body.postInputContext).toBeUndefined();
  });
});
