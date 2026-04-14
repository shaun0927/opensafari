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
import { registerAppTapElementTool, sanitizeTapTarget } from '../../src/tools/app-tap-element';
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

  it('surfaces totalMatches on a single-match tap', async () => {
    const node = makeNode({ frame: { x: 0, y: 0, width: 100, height: 50 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.totalMatches).toBe(1);
    expect(body.warning).toBeUndefined();
  });

  it('warns on implicit ambiguity when no index is provided', async () => {
    // Three candidates, caller did NOT pass an explicit `index` — we
    // still tap the first, but the response must flag the ambiguity.
    const nodes = [
      makeNode({ label: 'Item A', frame: { x: 0, y: 100, width: 100, height: 44 } }),
      makeNode({ label: 'Item B', frame: { x: 0, y: 200, width: 100, height: 44 } }),
      makeNode({ label: 'Item C', frame: { x: 0, y: 300, width: 100, height: 44 } }),
    ];
    mockQuery.mockResolvedValue(makeQueryResult(nodes, true));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { role: 'AXButton', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.totalMatches).toBe(3);
    expect(body.warning).toContain('ambiguous');
    expect(body.warning).toContain('3');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[app_tap_element\].*ambiguous/),
    );
    // First match is tapped when no index is supplied
    expect(body.coordinates).toEqual({ x: 50, y: 122 });

    warnSpy.mockRestore();
  });

  it('does not warn when caller disambiguates with explicit index', async () => {
    const nodes = [
      makeNode({ label: 'Item A', frame: { x: 0, y: 100, width: 100, height: 44 } }),
      makeNode({ label: 'Item B', frame: { x: 0, y: 200, width: 100, height: 44 } }),
    ];
    mockQuery.mockResolvedValue(makeQueryResult(nodes, true));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', {
      role: 'AXButton',
      index: 1,
      timeout: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.totalMatches).toBe(2);
    expect(body.warning).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/\[app_tap_element\].*ambiguous/),
    );

    warnSpy.mockRestore();
  });

  it('clamps a negative tap target to the device coordinate plane', async () => {
    // Element reported at (-4, -2) with 20x20 size → raw center is
    // (6, 8) which is fine; but shift it so center actually goes
    // negative: frame (-20, -20, 10, 10) → center (-15, -15).
    const node = makeNode({ frame: { x: -20, y: -20, width: 10, height: 10 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'Edge', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 0, y: 0 });
    expect(body.clampedFrom).toEqual({ x: -15, y: -15 });
    expect(body.warning).toContain('clamped');
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 0, 0, undefined);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[app_tap_element\].*outside the device coordinate plane/),
    );

    warnSpy.mockRestore();
  });

  it('clamps only the negative axis when the other is valid', async () => {
    // frame (-10, 100, 4, 40) → center (-8, 120). Only x needs clamp.
    const node = makeNode({ frame: { x: -10, y: 100, width: 4, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'LeftEdge', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 0, y: 120 });
    expect(body.clampedFrom).toEqual({ x: -8, y: 120 });
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 0, 120, undefined);

    warnSpy.mockRestore();
  });

  it('does not surface clampedFrom or warning on an in-bounds tap', async () => {
    const node = makeNode({ frame: { x: 50, y: 100, width: 100, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Normal', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.coordinates).toEqual({ x: 100, y: 120 });
    expect(body.clampedFrom).toBeUndefined();
    expect(body.warning).toBeUndefined();
  });

  it('returns error when the element frame produces non-finite coordinates', async () => {
    // A broken AX payload: Infinity width yields Infinity center.
    const node = makeNode({ frame: { x: 0, y: 0, width: Infinity, height: 10 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Broken', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toMatch(/finite/);
    // Infinity does not round-trip through JSON (→ null), so we just
    // confirm the element payload is surfaced with a width that is
    // no longer a usable finite number.
    expect(body.element).toMatchObject({ frame: { height: 10 } });
    expect(body.element.frame.width).toBeNull();
    expect(mockTap).not.toHaveBeenCalled();
  });
});

describe('sanitizeTapTarget', () => {
  it('returns coordinates unchanged when both are non-negative finite numbers', () => {
    expect(sanitizeTapTarget(100, 200)).toEqual({ x: 100, y: 200 });
    expect(sanitizeTapTarget(0, 0)).toEqual({ x: 0, y: 0 });
    expect(sanitizeTapTarget(136.5, 222.5)).toEqual({ x: 136.5, y: 222.5 });
  });

  it('clamps negative x to 0 and records the original', () => {
    const r = sanitizeTapTarget(-3, 200);
    expect(r.x).toBe(0);
    expect(r.y).toBe(200);
    expect(r.clampedFrom).toEqual({ x: -3, y: 200 });
  });

  it('clamps negative y to 0 and records the original', () => {
    const r = sanitizeTapTarget(50, -1);
    expect(r.x).toBe(50);
    expect(r.y).toBe(0);
    expect(r.clampedFrom).toEqual({ x: 50, y: -1 });
  });

  it('clamps both axes when both are negative', () => {
    const r = sanitizeTapTarget(-5, -10);
    expect(r).toEqual({
      x: 0,
      y: 0,
      clampedFrom: { x: -5, y: -10 },
    });
  });

  it('throws on NaN', () => {
    expect(() => sanitizeTapTarget(NaN, 100)).toThrow(/finite/);
    expect(() => sanitizeTapTarget(100, NaN)).toThrow(/finite/);
  });

  it('throws on Infinity', () => {
    expect(() => sanitizeTapTarget(Infinity, 100)).toThrow(/finite/);
    expect(() => sanitizeTapTarget(100, -Infinity)).toThrow(/finite/);
  });
});
