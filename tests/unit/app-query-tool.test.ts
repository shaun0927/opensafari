import { MCPServer } from '../../src/mcp-server';
import { registerAppQueryTool } from '../../src/tools/app-query';
import {
  AccessibilityBridge,
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';

jest.mock('../../src/native');
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'mock-device-id',
  }),
}));

const MockBridge = AccessibilityBridge as jest.MockedClass<typeof AccessibilityBridge>;
const mockGetBridge = getAccessibilityBridge as jest.MockedFunction<typeof getAccessibilityBridge>;
const mockEnsureSemanticsActive = ensureSemanticsActive as jest.MockedFunction<typeof ensureSemanticsActive>;

function makeTree() {
  return {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXButton',
        label: '마이\n탭 4개 중 4번째',
        identifier: 'my-tab',
        traits: [],
        frame: { x: 0, y: 0, width: 100, height: 40 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0',
      },
      {
        role: 'AXStaticText',
        label: '매일 무료 오픈',
        traits: [],
        frame: { x: 0, y: 50, width: 100, height: 20 },
        visible: true,
        enabled: true,
        focused: false,
        path: '1',
      },
    ],
  };
}

describe('app_query tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureSemanticsActive.mockResolvedValue(true);
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

  it('force-refreshes semantics and retries the query after an initial zero-match result', async () => {
    const queryMock = jest.fn()
      .mockResolvedValueOnce({
        matches: [],
        total: 0,
        query: { label: 'Email address field' },
        ambiguous: false,
      })
      .mockResolvedValueOnce({
        matches: [{ role: 'AXTextField', label: 'Email address field', path: '0/1' }],
        total: 1,
        query: { label: 'Email address field' },
        ambiguous: false,
      });
    MockBridge.prototype.query = queryMock;
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { label: 'Email address field' });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(mockEnsureSemanticsActive).toHaveBeenNthCalledWith(1, 'mock-device-id', {
      bundleId: undefined,
    });
    expect(mockEnsureSemanticsActive).toHaveBeenNthCalledWith(2, 'mock-device-id', {
      bundleId: undefined,
      forceRefresh: true,
    });

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.total).toBe(1);
    expect(parsed._meta.queryRecovery).toEqual({
      retriedAfterForceRefresh: true,
      recovered: true,
      matchStrategy: 'native',
    });
  });

  it('includes visible-tree diagnostics when force-refresh still yields zero matches', async () => {
    MockBridge.prototype.query = jest.fn().mockResolvedValue({
      matches: [],
      total: 0,
      query: { label: 'Send verification code' },
      ambiguous: false,
    });
    MockBridge.prototype.dumpTree = jest.fn().mockResolvedValue({
      role: 'AXGroup',
      path: '',
      visible: true,
      enabled: true,
      focused: false,
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          role: 'AXStaticText',
          label: 'Create Account',
          path: '0',
          visible: true,
          enabled: true,
          focused: false,
          traits: ['text'],
          frame: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          role: 'AXButton',
          label: 'Send code',
          path: '1',
          visible: true,
          enabled: true,
          focused: false,
          traits: ['button'],
          frame: { x: 0, y: 30, width: 100, height: 20 },
        },
      ],
    });
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { label: 'Send verification code' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.total).toBe(0);
    expect(parsed._meta.queryRecovery).toEqual({
      retriedAfterForceRefresh: true,
      recovered: false,
    });
    expect(parsed._meta.queryDiagnostics.nodeCount).toBeGreaterThan(0);
    expect(parsed._meta.queryDiagnostics.visibleSummary.staticTexts).toContain('Create Account');
    expect(parsed._meta.queryDiagnostics.visibleSummary.buttonLabels).toContain('Send code');
  });

  it('recovers a visible title through relaxed tree scanning when native query still returns zero matches', async () => {
    MockBridge.prototype.query = jest.fn().mockResolvedValue({
      matches: [],
      total: 0,
      query: { text: 'Create Account' },
      ambiguous: false,
    });
    MockBridge.prototype.dumpTree = jest.fn().mockResolvedValue({
      role: 'AXGroup',
      path: '',
      visible: true,
      enabled: true,
      focused: false,
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          role: 'AXGroup',
          path: '0',
          visible: true,
          enabled: true,
          focused: false,
          traits: ['group'],
          frame: { x: 0, y: 0, width: 200, height: 44 },
          children: [
            {
              role: 'AXStaticText',
              label: 'Create Account',
              path: '0/0',
              visible: true,
              enabled: true,
              focused: false,
              traits: ['text'],
              frame: { x: 0, y: 0, width: 200, height: 20 },
            },
          ],
        },
      ],
    });
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { text: 'Create Account' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.total).toBe(1);
    expect(parsed.matches[0].label).toBe('Create Account');
    expect(parsed._meta.queryRecovery).toEqual({
      retriedAfterForceRefresh: true,
      recovered: true,
      matchStrategy: 'relaxed-tree-scan',
    });
  });

  it('prefers the most specific visible descendant match during relaxed tree scanning', async () => {
    MockBridge.prototype.query = jest.fn().mockResolvedValue({
      matches: [],
      total: 0,
      query: { text: 'Projection' },
      ambiguous: false,
    });
    MockBridge.prototype.dumpTree = jest.fn().mockResolvedValue({
      role: 'AXGroup',
      path: '',
      visible: true,
      enabled: true,
      focused: false,
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          role: 'AXGroup',
          label: 'Card wrapper',
          path: '0',
          visible: true,
          enabled: true,
          focused: false,
          traits: ['group'],
          frame: { x: 0, y: 0, width: 300, height: 200 },
          children: [
            {
              role: 'AXStaticText',
              label: 'Projection',
              path: '0/0',
              visible: true,
              enabled: true,
              focused: false,
              traits: ['text'],
              frame: { x: 0, y: 0, width: 100, height: 20 },
            },
          ],
        },
      ],
    });
    mockGetBridge.mockReturnValue(new MockBridge());

    const result = await handler('session-1', { text: 'Projection' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.total).toBe(1);
    expect(parsed.matches[0].path).toBe('0/0');
    expect(parsed.matches[0].label).toBe('Projection');
  });
});
