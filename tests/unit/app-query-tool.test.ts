import { MCPServer } from '../../src/mcp-server';
import { registerAppQueryTool } from '../../src/tools/app-query';
import { AccessibilityBridge, getAccessibilityBridge } from '../../src/native';

jest.mock('../../src/native');
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getActiveDeviceId: () => 'mock-device-id',
  }),
}));

const MockBridge = AccessibilityBridge as jest.MockedClass<typeof AccessibilityBridge>;
const mockGetBridge = getAccessibilityBridge as jest.MockedFunction<typeof getAccessibilityBridge>;

describe('app_query tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = {
      registerTool: jest.fn((_def, h) => { handler = h; }),
    } as unknown as MCPServer;
    registerAppQueryTool(server);
  });

  it('registers with correct name', () => {
    const [def] = (server.registerTool as jest.Mock).mock.calls[0];
    expect(def.name).toBe('app_query');
  });

  it('returns error when no query params provided', async () => {
    const result = await handler('session-1', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least one query parameter');
  });

  it('queries by identifier and returns results', async () => {
    const mockResult = {
      matches: [{ role: 'AXButton', identifier: 'submit-btn', path: '0/1' }],
      total: 1,
      query: { identifier: 'submit-btn' },
      ambiguous: false,
    };

    MockBridge.prototype.query = jest.fn().mockResolvedValue(mockResult);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { identifier: 'submit-btn' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.total).toBe(1);
    expect(parsed.matches[0].identifier).toBe('submit-btn');
  });

  it('queries by label and text combined', async () => {
    const queryMock = jest.fn().mockResolvedValue({
      matches: [], total: 0, query: { label: 'Login', text: 'user' }, ambiguous: false,
    });
    MockBridge.prototype.query = queryMock;
    mockGetBridge.mockReturnValue(new MockBridge());

    await handler('session-1', { label: 'Login', text: 'user' });

    expect(queryMock).toHaveBeenCalledWith(
      { identifier: undefined, label: 'Login', text: 'user', role: undefined },
      expect.objectContaining({ deviceId: 'mock-device-id' }),
    );
  });

  it('includes ambiguity warning when query matches multiple elements', async () => {
    const ambiguousResult = {
      matches: [
        { role: 'AXButton', identifier: 'btn', path: '0/1' },
        { role: 'AXButton', identifier: 'btn', path: '0/3' },
      ],
      total: 2,
      query: { identifier: 'btn' },
      ambiguous: true,
    };

    MockBridge.prototype.query = jest.fn().mockResolvedValue(ambiguousResult);
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { identifier: 'btn' });

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.warning).toContain('Ambiguous');
    expect(parsed.total).toBe(2);
  });
});
