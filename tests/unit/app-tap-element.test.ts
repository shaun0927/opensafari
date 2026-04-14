/**
 * Unit tests for app_tap_element tool.
 *
 * Tests the composite flow: query accessibility tree → calculate center → tap.
 */

// Mock getWebKitClient before importing tool modules
jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppTapElementTool } from '../../src/tools/app-tap-element';
import type { AXNode, AXQueryResult } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockDumpTree = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);

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

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    tap: mockTap,
  })),
  resetInputBackend: jest.fn(),
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
    label: 'Login',
    identifier: 'login_btn',
    traits: [],
    frame: { x: 100, y: 200, width: 200, height: 44 },
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

// ── Test Setup ───────────────────────────────────────────────────────────────

let server: MCPServer;
let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

beforeAll(() => {
  server = {
    registerTool: jest.fn((schema: unknown, fn: unknown) => {
      handler = fn as typeof handler;
    }),
  } as unknown as MCPServer;

  registerAppTapElementTool(server);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('app_tap_element', () => {
  it('taps element found by label', async () => {
    const node = makeNode({ label: 'Login', frame: { x: 100, y: 200, width: 200, height: 44 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 200, y: 222 }); // center of 100+200/2, 200+44/2
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, undefined);
  });

  it('taps element found by identifier', async () => {
    const node = makeNode({ identifier: 'submit_btn', frame: { x: 50, y: 300, width: 100, height: 50 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { identifier: 'submit_btn', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 100, y: 325 });
  });

  it('taps element found by role', async () => {
    const node = makeNode({ role: 'AXTextField', frame: { x: 20, y: 100, width: 350, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { role: 'AXTextField', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 195, y: 120 });
  });

  it('selects correct match using index parameter', async () => {
    const nodes = [
      makeNode({ label: 'Item 1', frame: { x: 0, y: 100, width: 100, height: 44 } }),
      makeNode({ label: 'Item 2', frame: { x: 0, y: 200, width: 100, height: 44 } }),
      makeNode({ label: 'Item 3', frame: { x: 0, y: 300, width: 100, height: 44 } }),
    ];
    mockQuery.mockResolvedValue(makeQueryResult(nodes));

    const result = await handler('session', { role: 'AXButton', index: 2, timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 50, y: 322 }); // center of 3rd item
  });

  it('returns error when no query parameters provided', async () => {
    const result = await handler('session', {});

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('At least one query parameter');
  });

  it('returns error when element not found', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await handler('session', { label: 'NonExistent', timeout: 0 });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Element not found');
  });

  it('returns error when element is not visible', async () => {
    const node = makeNode({ visible: false, frame: { x: 0, y: 0, width: 0, height: 0 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Hidden', timeout: 0 });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('not visible');
  });

  it('supports long press via duration parameter', async () => {
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    await handler('session', { label: 'Login', duration: 2, timeout: 0 });

    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, 2);
  });

  it('waits for element with timeout', async () => {
    jest.useFakeTimers();

    // First call: not found. Second call: found.
    mockQuery
      .mockResolvedValueOnce(makeQueryResult([]))
      .mockResolvedValue(makeQueryResult([makeNode()]));

    const promise = handler('session', { label: 'Login', timeout: 5000 });
    await jest.advanceTimersByTimeAsync(400);
    const result = await promise;

    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('tapped');

    jest.useRealTimers();
  });

  it('returns element metadata in response', async () => {
    const node = makeNode({
      role: 'AXButton',
      label: 'Submit',
      identifier: 'submit_btn',
      path: '0/3/1',
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { identifier: 'submit_btn', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.element).toEqual({
      role: 'AXButton',
      label: 'Submit',
      identifier: 'submit_btn',
      path: '0/3/1',
    });
    expect(body.backend).toBe('simctl');
    expect(body.deviceId).toBe('test-device-id');
  });

  it('taps element found by text parameter', async () => {
    const node = makeNode({
      label: 'Submit form',
      frame: { x: 10, y: 20, width: 100, height: 50 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { text: 'Submit', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 60, y: 45 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Submit' }),
      expect.anything(),
    );
  });

  it('passes compound query (role + label) to the accessibility bridge', async () => {
    const node = makeNode({
      role: 'AXButton',
      label: 'Login',
      frame: { x: 100, y: 200, width: 200, height: 44 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      role: 'AXButton',
      label: 'Login',
      timeout: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'AXButton', label: 'Login' }),
      expect.anything(),
    );
  });

  it('calculates correct center for frames with odd width/height', async () => {
    // Odd dimensions produce non-integer centers — we preserve precision
    // rather than rounding because simctl / WebKit tap accept floats and
    // rounding halves can bias away from the true center by up to 0.5pt.
    const node = makeNode({ frame: { x: 100, y: 200, width: 73, height: 45 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Odd', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    // Center: 100 + 73/2 = 136.5, 200 + 45/2 = 222.5
    expect(body.coordinates).toEqual({ x: 136.5, y: 222.5 });
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 136.5, 222.5, undefined);
  });

  it('calculates correct center for fractional frame origins', async () => {
    // Flutter reports sub-pixel coordinates (e.g. 93.666…) on scaled displays.
    const node = makeNode({
      frame: { x: 93.66666666666663, y: 550.6666666666666, width: 140, height: 48 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Fractional', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.coordinates.x).toBeCloseTo(163.6667, 3);
    expect(body.coordinates.y).toBeCloseTo(574.6667, 3);
  });

  it('treats empty string query params as absent (rejects request)', async () => {
    // All-empty params should be treated the same as no params provided —
    // the tool should reject rather than sending a match-everything query
    // to the bridge.
    const result = await handler('session', {
      identifier: '',
      label: '',
      text: '',
      role: '',
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('At least one query parameter');
  });

  it('empty label falls back to other non-empty query params', async () => {
    // When a caller passes label: '' alongside a real query (e.g. role),
    // the tool should proceed using the non-empty params rather than
    // rejecting or short-circuiting.
    const node = makeNode({
      role: 'AXButton',
      label: 'Continue',
      frame: { x: 0, y: 0, width: 200, height: 44 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      label: '',
      role: 'AXButton',
      timeout: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'AXButton' }),
      expect.anything(),
    );
  });
});
