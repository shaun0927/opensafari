/**
 * Unit tests for app_wait_for (native) and app_assert_element tools.
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppWaitForNativeTool } from '../../src/tools/app-wait-for';
import { registerAppAssertElementTool } from '../../src/tools/app-assert-element';
import type { AXNode, AXQueryResult } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockDumpTree = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    query: mockQuery,
    dumpTree: mockDumpTree,
  }),
}));

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(10),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXButton',
    label: 'Welcome',
    identifier: 'welcome_label',
    traits: [],
    frame: { x: 50, y: 200, width: 300, height: 44 },
    visible: true,
    enabled: true,
    focused: false,
    path: '0/1',
    ...overrides,
  };
}

function makeQueryResult(matches: AXNode[]): AXQueryResult {
  return { matches, total: matches.length, query: {}, ambiguous: false };
}

type ToolHandler = (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

// ── Setup ────────────────────────────────────────────────────────────────────

let waitHandler: ToolHandler;
let assertHandler: ToolHandler;

beforeAll(() => {
  const mockServer = {
    registerTool: jest.fn((_schema: unknown, _fn: unknown) => {}),
  } as unknown as MCPServer;

  // Capture wait_for handler
  registerAppWaitForNativeTool(mockServer);
  waitHandler = (mockServer.registerTool as jest.Mock).mock.calls[0][1];

  // Capture assert_element handler
  registerAppAssertElementTool(mockServer);
  assertHandler = (mockServer.registerTool as jest.Mock).mock.calls[1][1];
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDumpTree.mockResolvedValue({
    role: 'AXGroup',
    children: [],
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
  });
});

// ── app_wait_for Tests ───────────────────────────────────────────────────────

describe('app_wait_for', () => {
  it('returns immediately when element already exists', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode()]));

    const result = await waitHandler('session', {
      label: 'Welcome',
      timeout: 5000,
      interval: 100,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('found');
    expect(body.condition).toBe('exists');
    expect(body.polls).toBe(1);
    expect(body.element).toBeTruthy();
    expect(body.element.label).toBe('Welcome');
  });

  it('polls until element appears', async () => {
    jest.useFakeTimers();

    mockQuery
      .mockResolvedValueOnce(makeQueryResult([]))
      .mockResolvedValueOnce(makeQueryResult([]))
      .mockResolvedValue(makeQueryResult([makeNode()]));

    const promise = waitHandler('session', {
      label: 'Welcome',
      timeout: 5000,
      interval: 100,
    });

    await jest.advanceTimersByTimeAsync(300);
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('found');
    expect(body.polls).toBeGreaterThanOrEqual(2);

    jest.useRealTimers();
  });

  it('returns timeout error when element never appears', async () => {
    jest.useFakeTimers();

    mockQuery.mockResolvedValue(makeQueryResult([]));

    const promise = waitHandler('session', {
      label: 'Missing',
      timeout: 500,
      interval: 100,
    });

    await jest.advanceTimersByTimeAsync(600);
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('APP_STATE_UNKNOWN');
    expect(body.message).toBe('Timeout waiting for element');
    expect(body.timeout).toBe(500);

    jest.useRealTimers();
  });

  it('waits for condition: not_exists', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await waitHandler('session', {
      label: 'Spinner',
      condition: 'not_exists',
      timeout: 1000,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('found');
    expect(body.condition).toBe('not_exists');
    expect(body.element).toBeNull();
  });

  it('waits for condition: visible', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ visible: true })]));

    const result = await waitHandler('session', {
      label: 'Welcome',
      condition: 'visible',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('found');
    expect(body.condition).toBe('visible');
  });

  it('waits for condition: enabled', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ enabled: true })]));

    const result = await waitHandler('session', {
      label: 'Submit',
      condition: 'enabled',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('found');
    expect(body.condition).toBe('enabled');
  });

  it('returns error when no query parameters given', async () => {
    const result = await waitHandler('session', {});
    expect(result.isError).toBe(true);
  });
});

// ── app_assert_element Tests ─────────────────────────────────────────────────

describe('app_assert_element', () => {
  it('passes when element exists', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode()]));

    const result = await assertHandler('session', {
      label: 'Welcome',
      assert: 'exists',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.condition).toBe('exists');
    expect(result.isError).toBeFalsy();
  });

  it('fails when element does not exist', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));
    mockDumpTree.mockResolvedValue({
      role: 'AXGroup',
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [
        makeNode({ label: '마이\n탭 4개 중 4번째', identifier: 'my-tab', path: '0/1' }),
        makeNode({ label: '매일 무료 오픈', identifier: 'daily-open', path: '0/2', role: 'AXStaticText' }),
      ],
    });

    const result = await assertHandler('session', {
      label: 'Missing',
      assert: 'exists',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(result.isError).toBe(true);
    expect(body.debug.candidates).toContain('마이 탭 4개 중 4번째');
    expect(body.debug.candidates).toContain('매일 무료 오픈');
  });

  it('passes assert not_exists when element missing', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await assertHandler('session', {
      label: 'Spinner',
      assert: 'not_exists',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('passes assert visible when element visible', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ visible: true })]));

    const result = await assertHandler('session', {
      label: 'Welcome',
      assert: 'visible',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('fails assert visible when element hidden', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ visible: false })]));

    const result = await assertHandler('session', {
      label: 'Hidden',
      assert: 'visible',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
  });

  it('passes assert enabled', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ enabled: true })]));

    const result = await assertHandler('session', {
      label: 'Submit',
      assert: 'enabled',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('passes assert disabled', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ enabled: false })]));

    const result = await assertHandler('session', {
      label: 'Submit',
      assert: 'disabled',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('passes assert has_text when text matches', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ value: 'Hello World' })]));

    const result = await assertHandler('session', {
      label: 'Greeting',
      assert: 'has_text',
      expected_text: 'Hello',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('fails assert has_text when text does not match', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode({ value: 'Goodbye' })]));

    const result = await assertHandler('session', {
      label: 'Greeting',
      assert: 'has_text',
      expected_text: 'Hello',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
  });

  it('requires expected_text for has_text condition', async () => {
    const result = await assertHandler('session', {
      label: 'Test',
      assert: 'has_text',
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('INVALID_INPUT');
    expect(body.message).toContain('expected_text is required');
  });

  it('includes custom message in result', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([makeNode()]));

    const result = await assertHandler('session', {
      label: 'Welcome',
      assert: 'exists',
      message: 'Welcome screen should appear after login',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.message).toBe('Welcome screen should appear after login');
  });

  it('returns error when no query parameters given', async () => {
    const result = await assertHandler('session', {});
    expect(result.isError).toBe(true);
  });
});
