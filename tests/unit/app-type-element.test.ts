/**
 * Unit tests for app_type_element tool.
 *
 * Tests the composite flow: query accessibility tree → tap to focus →
 * type text. Mocks the same boundaries as app-tap-element.test.ts
 * (accessibility bridge, semantics activator, input backend,
 * session manager) so these stay pure unit tests.
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppTypeElementTool } from '../../src/tools/app-type-element';
import type { AXNode, AXQueryResult } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);
const mockTypeText = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    query: mockQuery,
    dumpTree: jest.fn(),
  }),
}));

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(10),
}));

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    tap: mockTap,
    typeText: mockTypeText,
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXTextField',
    label: 'Email',
    identifier: 'email_field',
    traits: [],
    frame: { x: 20, y: 100, width: 350, height: 40 },
    visible: true,
    enabled: true,
    focused: false,
    path: '0/1',
    ...overrides,
  };
}

function makeQueryResult(matches: AXNode[], ambiguous = false): AXQueryResult {
  return {
    matches,
    total: matches.length,
    query: {},
    ambiguous,
  };
}

// ── Test setup ─────────────────────────────────────────────────────────────

let server: MCPServer;
let handler: (
  sessionId: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

beforeAll(() => {
  server = {
    registerTool: jest.fn((_schema: unknown, fn: unknown) => {
      handler = fn as typeof handler;
    }),
  } as unknown as MCPServer;

  registerAppTypeElementTool(server);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('app_type_element', () => {
  it('types into element found by label', async () => {
    const node = makeNode({ label: 'Email', frame: { x: 20, y: 100, width: 350, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      label: 'Email',
      text: 'user@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('typed');
    expect(body.length).toBe(16);
    expect(body.coordinates).toEqual({ x: 195, y: 120 }); // 20+175, 100+20
    // Tap to focus
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 195, 120);
    // Then type
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'user@example.com');
    // Tap must come before typeText
    const tapOrder = mockTap.mock.invocationCallOrder[0];
    const typeOrder = mockTypeText.mock.invocationCallOrder[0];
    expect(tapOrder).toBeLessThan(typeOrder);
  });

  it('types into element found by identifier', async () => {
    const node = makeNode({ identifier: 'username_input', frame: { x: 10, y: 200, width: 200, height: 44 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'username_input',
      text: 'alice',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('typed');
    expect(body.coordinates).toEqual({ x: 110, y: 222 });
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'alice');
  });

  it('uses index to disambiguate multiple fields', async () => {
    const nodes = [
      makeNode({ identifier: 'field_0', frame: { x: 0, y: 100, width: 100, height: 40 } }),
      makeNode({ identifier: 'field_1', frame: { x: 0, y: 200, width: 100, height: 40 } }),
    ];
    mockQuery.mockResolvedValue(makeQueryResult(nodes));

    await handler('session', {
      role: 'AXTextField',
      text: 'hello',
      index: 1,
      timeout: 0,
      focusDelay: 0,
    });

    expect(mockTap).toHaveBeenCalledWith('test-device-id', 50, 220);
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'hello');
  });

  it('returns error when text is missing or empty', async () => {
    const missing = await handler('session', { label: 'Email' });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text).error).toContain('text');

    const empty = await handler('session', { label: 'Email', text: '' });
    expect(empty.isError).toBe(true);
    expect(JSON.parse(empty.content[0].text).error).toContain('text');
  });

  it('returns error when no locator is provided', async () => {
    const result = await handler('session', { text: 'hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('query parameter');
  });

  it('returns error when element is not found', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await handler('session', {
      label: 'NonExistent',
      text: 'hello',
      timeout: 0,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('Element not found');
    expect(mockTap).not.toHaveBeenCalled();
    expect(mockTypeText).not.toHaveBeenCalled();
  });

  it('returns error when element is not visible', async () => {
    const node = makeNode({ visible: false, frame: { x: 0, y: 0, width: 0, height: 0 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      label: 'Hidden',
      text: 'nope',
      timeout: 0,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('not visible');
    expect(mockTypeText).not.toHaveBeenCalled();
  });

  it('waits between tap-to-focus and typing when focusDelay > 0', async () => {
    const node = makeNode({ frame: { x: 0, y: 0, width: 100, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    let tapCompletedAt = 0;
    let typeStartedAt = 0;
    mockTap.mockImplementation(async () => {
      tapCompletedAt = Date.now();
    });
    mockTypeText.mockImplementation(async () => {
      typeStartedAt = Date.now();
    });

    await handler('session', {
      label: 'Field',
      text: 'x',
      timeout: 0,
      focusDelay: 75,
    });

    // Typing started at least ~75ms after tap completed. Allow a
    // small tolerance for scheduler jitter.
    expect(typeStartedAt - tapCompletedAt).toBeGreaterThanOrEqual(60);
  });

  it('never sends the `text` param as part of the bridge query', async () => {
    // `text` is overloaded to mean "text to type" here, so it MUST NOT be
    // forwarded to the accessibility query (which treats it as a substring
    // match against value/label) — otherwise the query could fail to find
    // the empty field we are about to populate.
    const node = makeNode({ frame: { x: 10, y: 20, width: 100, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    await handler('session', {
      label: 'Password',
      text: 'supersecret',
      timeout: 0,
      focusDelay: 0,
    });

    const forwardedQuery = mockQuery.mock.calls[0][0];
    expect(forwardedQuery).not.toHaveProperty('text');
    expect(forwardedQuery).toMatchObject({ label: 'Password' });
  });

  it('returns element metadata in response', async () => {
    const node = makeNode({
      role: 'AXTextField',
      label: 'Search',
      identifier: 'search_input',
      path: '0/2/3',
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'search_input',
      text: 'query',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.element).toEqual({
      role: 'AXTextField',
      label: 'Search',
      identifier: 'search_input',
      path: '0/2/3',
    });
    expect(body.backend).toBe('simctl');
    expect(body.deviceId).toBe('test-device-id');
  });
});
