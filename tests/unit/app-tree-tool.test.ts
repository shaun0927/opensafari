import { MCPServer } from '../../src/mcp-server';
import { registerAppTreeTool } from '../../src/tools/app-tree';
import { AccessibilityBridge, getAccessibilityBridge } from '../../src/native';

jest.mock('../../src/native');
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
