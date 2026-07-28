import { MCPServer } from '../../src/mcp-server';
import { ErrorCode } from '../../src/errors';
import { AccessibilityBridgeError } from '../../src/native/accessibility-bridge';

const listBootedMock = jest.fn();
const listRunningAppsMock = jest.fn();
const dumpTreeMock = jest.fn();
const getSoleDeviceIdMock = jest.fn();

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: listBootedMock,
    listRunningApps: listRunningAppsMock,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: getSoleDeviceIdMock }),
}));

jest.mock('../../src/native', () => {
  const actual = jest.requireActual('../../src/native');
  return {
    ...actual,
    getAccessibilityBridge: () => ({ dumpTree: dumpTreeMock }),
  };
});

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({ isConnected: () => false }),
}));

function axTree() {
  return {
    role: 'AXApplication',
    label: 'Example',
    identifier: 'com.example.app',
    value: undefined,
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    traits: [],
    path: '/0',
    children: [
      { role: 'AXButton', label: 'Settings', identifier: 'settings_button', value: undefined, frame: { x: 1, y: 1, width: 44, height: 44 }, visible: true, enabled: true, focused: false, traits: [], path: '/0/1', children: [] },
    ],
  };
}

function parseToolError(result: { isError?: boolean; content?: Array<{ text?: string }> }) {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('app_state_snapshot contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBootedMock.mockResolvedValue([{ udid: 'D1', name: 'iPhone 15' }]);
    listRunningAppsMock.mockResolvedValue([{ label: 'com.example.app', pid: 123 }]);
    dumpTreeMock.mockResolvedValue(axTree());
    getSoleDeviceIdMock.mockReturnValue('D1');
  });

  it('returns compact non-mutating state with confidence and recovery hints', async () => {
    const { collectAppSessionState } = await import('../../src/tools/app-state-snapshot');
    const state = await collectAppSessionState({ expectedBundleId: 'com.example.app', includeFlutter: true, includeWebView: true });
    expect(state.schemaVersion).toBe('1');
    expect(state.device.id).toBe('D1');
    expect(state.ui.visibleSummary[0]).toMatchObject({ role: 'AXApplication' });
    expect(state.flutter).toMatchObject({ vmConnected: false });
    expect(state.confidence).toMatch(/verified|heuristic|unknown/);
    expect(state.recoveryHints.some((h) => h.action === 'debug_bundle_collect' && h.destructive === false)).toBe(true);
  });

  it('reports DEVICE_NOT_BOOTED only when no device can be resolved', async () => {
    listBootedMock.mockResolvedValueOnce([]);
    getSoleDeviceIdMock.mockReturnValueOnce(null);
    const { registerAppStateSnapshotTool } = await import('../../src/tools/app-state-snapshot');
    const server = new MCPServer();
    registerAppStateSnapshotTool(server);

    const result = await server.getToolHandler('app_state_snapshot')!('s', {});
    const payload = parseToolError(result);
    expect(payload.error).toBe(ErrorCode.DEVICE_NOT_BOOTED);
  });

  it('reports APP_STATE_UNKNOWN for snapshot collection failures after device resolution', async () => {
    dumpTreeMock.mockRejectedValueOnce(new Error('AX dump failed'));
    const { registerAppStateSnapshotTool } = await import('../../src/tools/app-state-snapshot');
    const server = new MCPServer();
    registerAppStateSnapshotTool(server);

    const result = await server.getToolHandler('app_state_snapshot')!('s', {});
    const payload = parseToolError(result);
    expect(payload.error).toBe(ErrorCode.APP_STATE_UNKNOWN);
    expect(payload.message).toContain('AX dump failed');
  });

  it('surfaces AX topology diagnostics on recoverable bridge failures', async () => {
    const topology = {
      windowCount: 2,
      overlayRolesSeen: 0,
      winner: { depth: 1, role: 'AXGroup', label: null, score: 5, appSemanticsCount: 0 },
    };
    dumpTreeMock.mockRejectedValueOnce(
      new AccessibilityBridgeError(
        'No descendant subtree contains app semantics',
        'DEVICE_CONTENT_ROOT_EMPTY',
        topology,
      ),
    );
    const { registerAppStateSnapshotTool } = await import('../../src/tools/app-state-snapshot');
    const server = new MCPServer();
    registerAppStateSnapshotTool(server);

    const result = await server.getToolHandler('app_state_snapshot')!('s', {});
    const payload = parseToolError(result);
    expect(payload.error).toBe(ErrorCode.APP_STATE_UNKNOWN);
    expect(payload.axBridgeCode).toBe('DEVICE_CONTENT_ROOT_EMPTY');
    expect(payload.axTopology).toEqual(topology);
  });
});
