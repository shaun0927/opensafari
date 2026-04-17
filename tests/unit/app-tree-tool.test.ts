import { MCPServer } from '../../src/mcp-server';
import { registerAppTreeTool } from '../../src/tools/app-tree';
import {
  AccessibilityBridge,
  getAccessibilityBridge,
  ensureSemanticsActive,
  FlutterSemanticsUnavailableError,
} from '../../src/native';

// Preserve the real FlutterSemanticsUnavailableError class (so it carries the
// `.reason` field) while mocking AccessibilityBridge / getAccessibilityBridge
// / ensureSemanticsActive. A bare `jest.mock('../../src/native')` would
// auto-mock the error class too, dropping the constructor body.
jest.mock('../../src/native', () => {
  const actual = jest.requireActual('../../src/native');
  return {
    ...actual,
    AccessibilityBridge: jest.fn(),
    getAccessibilityBridge: jest.fn(),
    ensureSemanticsActive: jest.fn(),
  };
});
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'mock-device-id',
  }),
}));

const MockBridge = AccessibilityBridge as jest.MockedClass<typeof AccessibilityBridge>;
const mockGetBridge = getAccessibilityBridge as jest.MockedFunction<typeof getAccessibilityBridge>;

describe('app_tree tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default ensureSemanticsActive to a successful no-op so existing tests
    // exercise the success path. The fallback-shape test below overrides this
    // to reject with FlutterSemanticsUnavailableError.
    (ensureSemanticsActive as jest.Mock).mockResolvedValue(true);

    server = {
      registerTool: jest.fn((_def, h) => { handler = h; }),
    } as unknown as MCPServer;

    registerAppTreeTool(server);
  });

  it('registers with correct name and schema', () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const [def] = (server.registerTool as jest.Mock).mock.calls[0];
    expect(def.name).toBe('app_tree');
    expect(def.inputSchema.properties).toHaveProperty('device_id');
    expect(def.inputSchema.properties).toHaveProperty('max_depth');
  });

  it('returns accessibility tree as JSON', async () => {
    const mockTree = {
      role: 'AXGroup',
      label: 'Content',
      path: '',
      children: [{ role: 'AXButton', label: 'OK', path: '0' }],
    };

    MockBridge.prototype.dumpTree = jest.fn().mockResolvedValue(mockTree);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', {});

    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.role).toBe('AXGroup');
    expect(parsed.children).toHaveLength(1);
  });

  it('passes device_id and max_depth options', async () => {
    const dumpMock = jest.fn().mockResolvedValue({ role: 'AXGroup', path: '' });
    MockBridge.prototype.dumpTree = dumpMock;
    mockGetBridge.mockReturnValue(new MockBridge());

    await handler('session-1', { device_id: 'custom-udid', max_depth: 3 });

    expect(dumpMock).toHaveBeenCalledWith({ deviceId: 'custom-udid', maxDepth: 3 });
  });

  it('preserves top-level AX node shape (role/children) when Semantics fallback fires', async () => {
    // Fallback path: ensureSemanticsActive throws FlutterSemanticsUnavailableError.
    // The response must keep root-level role/children/path so existing
    // consumers (e.g. assert_element, query) continue to work, while
    // surfacing a `semanticsWarning` field as a sibling.
    const fallbackTree = {
      role: 'AXGroup',
      label: 'Fallback root',
      path: '',
      children: [{ role: 'AXButton', label: 'Cancel', path: '0' }],
    };

    (ensureSemanticsActive as jest.Mock).mockRejectedValue(
      new FlutterSemanticsUnavailableError('timeout', 'simulated activation timeout'),
    );
    MockBridge.prototype.dumpTree = jest.fn().mockResolvedValue(fallbackTree);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text!);
    // Top-level fields must be preserved (back-compat).
    expect(parsed.role).toBe('AXGroup');
    expect(parsed.label).toBe('Fallback root');
    expect(parsed.path).toBe('');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0].role).toBe('AXButton');
    // The new warning field must be present.
    expect(typeof parsed.semanticsWarning).toBe('string');
    expect(parsed.semanticsWarning).toContain('reason: timeout');
    // The fallback must NOT wrap the tree in a new envelope.
    expect(parsed.tree).toBeUndefined();
  });

  it('returns error on bridge failure', async () => {
    const err = new Error('Simulator not running');
    err.name = 'AccessibilityBridgeError';
    MockBridge.prototype.dumpTree = jest.fn().mockRejectedValue(err);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Simulator not running');
  });
});
