import { MCPServer } from '../../src/mcp-server';
import { registerAppSwipeNativeTool } from '../../src/tools/app-swipe';

const mockSwipe = jest.fn().mockResolvedValue(undefined);
const mockProbeMobileContext = jest.fn();

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simhid' as const,
    swipe: mockSwipe,
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

describe('app_swipe_native tool', () => {
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
    registerAppSwipeNativeTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProbeMobileContext.mockResolvedValue({
      deviceId: 'TEST-UDID-1234',
      surface: 'unknown',
      contextVerified: false,
      expectedBundle: 'com.example.target',
      expectedBundleMatch: 'unknown',
      expectedBundleMatchConfidence: 'unknown',
      reason: 'ambiguous',
      warnings: ['unable to verify'],
      runningApps: [{ bundleId: 'com.example.target', pid: 123 }],
      visibleSummary: {
        buttonLabels: [],
        staticTexts: [],
        textFieldLabels: [],
        nodeCount: 0,
      },
    });
  });

  test('includes postInputContext when verifying a swipe', async () => {
    const result = await handler('test', {
      direction: 'up',
      verifyContext: true,
      expectedBundle: 'com.example.target',
      settleMs: 0,
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('swiped');
    expect(body.postInputContext.expectedBundleMatch).toBe('unknown');
    expect(body.warning).toContain('Post-swipe context did not confirm expected bundle');
  });

  test('returns swipe success with warning when post-swipe context probe throws', async () => {
    mockProbeMobileContext.mockRejectedValueOnce(new Error('AX dump failed'));

    const result = await handler('test', {
      direction: 'up',
      verifyContext: true,
      settleMs: 0,
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('swiped');
    const warningObj = JSON.parse(body.warning);
    expect(warningObj.warning).toBe('POST_SWIPE_CONTEXT_PROBE_FAILED');
    expect(warningObj.reason).toBe('AX dump failed');
    expect(body.postInputContext).toBeUndefined();
  });
});
