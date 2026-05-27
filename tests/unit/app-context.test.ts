import { MCPServer } from '../../src/mcp-server';
import { registerAppContextTool } from '../../src/tools/app-context';

const mockDumpTree = jest.fn();
const mockListBooted = jest.fn();
const mockListRunningApps = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: mockDumpTree,
  }),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: mockListBooted,
    listRunningApps: mockListRunningApps,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'TEST-UDID-1234',
  }),
}));

describe('app_context tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;

  beforeAll(() => {
    server = {
      registerTool: jest.fn((_schema: unknown, fn: unknown) => {
        handler = fn as typeof handler;
      }),
    } as unknown as MCPServer;
    registerAppContextTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockListBooted.mockResolvedValue([{ udid: 'TEST-UDID-1234' }]);
    mockListRunningApps.mockResolvedValue([
      { label: 'com.example.target', pid: 123 },
    ]);
    mockDumpTree.mockResolvedValue({
      role: 'AXGroup',
      traits: [],
      frame: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [
        {
          role: 'AXStaticText',
          label: 'Welcome back',
          traits: [],
          frame: { x: 0, y: 0, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0',
        },
      ],
    });
  });

  test('returns context diagnostics for the active device', async () => {
    const result = await handler('test', {});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.deviceId).toBe('TEST-UDID-1234');
    expect(body.surface).toBe('app_content');
    expect(body.runningApps[0].bundleId).toBe('com.example.target');
  });

  test('returns an error when requireMatch is set and the context mismatches', async () => {
    mockDumpTree.mockResolvedValue({
      role: 'AXGroup',
      traits: [],
      frame: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [
        {
          role: 'AXButton',
          label: 'Safari',
          traits: [],
          frame: { x: 0, y: 0, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0',
        },
        {
          role: 'AXButton',
          label: '설정',
          traits: [],
          frame: { x: 0, y: 20, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '1',
        },
        {
          role: 'AXButton',
          label: '사진',
          traits: [],
          frame: { x: 0, y: 40, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '2',
        },
        {
          role: 'AXButton',
          label: '메시지',
          traits: [],
          frame: { x: 0, y: 60, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '3',
        },
        {
          role: 'AXButton',
          label: '지도',
          traits: [],
          frame: { x: 0, y: 80, width: 80, height: 20 },
          visible: true,
          enabled: true,
          focused: false,
          path: '4',
        },
      ],
    });

    const result = await handler('test', {
      expectedBundle: 'com.example.target',
      requireMatch: true,
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('APP_STATE_UNKNOWN');
    expect(body.message).toContain('Expected bundle')
    expect(body.surface).toBe('springboard_like');
  });
});
