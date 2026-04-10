import { MCPServer } from '../../src/mcp-server';
import { registerAppInspectTool } from '../../src/tools/app-inspect';
import { AccessibilityBridge, getAccessibilityBridge } from '../../src/native';

jest.mock('../../src/native');
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'mock-device-id',
  }),
}));

const MockBridge = AccessibilityBridge as jest.MockedClass<typeof AccessibilityBridge>;
const mockGetBridge = getAccessibilityBridge as jest.MockedFunction<typeof getAccessibilityBridge>;

describe('app_inspect tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = {
      registerTool: jest.fn((_def, h) => { handler = h; }),
    } as unknown as MCPServer;
    registerAppInspectTool(server);
  });

  it('registers with correct name and required path param', () => {
    const [def] = (server.registerTool as jest.Mock).mock.calls[0];
    expect(def.name).toBe('app_inspect');
    expect(def.inputSchema.required).toContain('path');
  });

  it('returns detailed element metadata', async () => {
    const mockNode = {
      role: 'AXTextField',
      label: 'Email',
      value: 'user@test.com',
      identifier: 'email-field',
      traits: ['AXSearchField'],
      frame: { x: 20, y: 150, width: 350, height: 44 },
      visible: true,
      enabled: true,
      focused: true,
      children: null,
      path: '0/2',
    };

    MockBridge.prototype.inspect = jest.fn().mockResolvedValue(mockNode);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { path: '0/2' });

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.role).toBe('AXTextField');
    expect(parsed.identifier).toBe('email-field');
    expect(parsed.focused).toBe(true);
  });

  it('passes device_id to bridge', async () => {
    const inspectMock = jest.fn().mockResolvedValue({ role: 'AXButton', path: '0' });
    MockBridge.prototype.inspect = inspectMock;
    mockGetBridge.mockReturnValue(new MockBridge());

    await handler('session-1', { path: '0', device_id: 'custom-udid' });

    expect(inspectMock).toHaveBeenCalledWith('0', 'custom-udid');
  });

  it('returns error when element not found', async () => {
    const err = new Error('Element not found at path: 99/99');
    err.name = 'AccessibilityBridgeError';
    MockBridge.prototype.inspect = jest.fn().mockRejectedValue(err);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { path: '99/99' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Element not found');
  });
});
