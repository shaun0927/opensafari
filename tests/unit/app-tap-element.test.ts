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
import {
  registerAppTapElementTool,
  sanitizeTapTarget,
  __resetIosPtSizeCacheForTests,
} from '../../src/tools/app-tap-element';
import type { AXNode, AXQueryResult } from '../../src/native/ax-types';
import { DEVICE_PRESETS } from '../../src/simulator/presets';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockDumpTree = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);
// Default: report the element as not-actionable so every pre-existing
// coordinate-tap test continues to exercise the Tier-1-and-below backend
// chain unchanged. Tests targeting the new Tier-1.5 AX press path override
// this with `mockPress.mockResolvedValueOnce({ ok: true, ... })`.
const mockPress = jest.fn().mockResolvedValue({
  ok: false,
  code: 'PRESS_NOT_ACTIONABLE',
  path: '',
  actions: [],
  role: null,
  identifier: null,
  label: null,
  message: 'Element does not support AXPress',
  axErrorCode: null,
});

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    query: mockQuery,
    dumpTree: mockDumpTree,
    press: mockPress,
  }),
}));

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(10),
  isLikelyChromeOnlyTree: jest.fn().mockReturnValue(false),
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

// SimulatorManager is used to look up the iOS-pt size for coordinate conversion.
// Default: return null (device not in preset table) so pre-existing tests are
// unaffected. Individual tests override this via mockGetDevice.
const mockGetDevice = jest.fn().mockResolvedValue(null);
jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    getDevice: mockGetDevice,
  })),
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

function makeNodeTree(node: AXNode): AXNode {
  return {
    role: 'AXWindow',
    label: 'Test App',
    traits: [],
    frame: { x: 0, y: 0, width: 375, height: 812 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [node],
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
  // The iOS-pt size cache is module-level so a previous test's resolved
  // size would otherwise leak into subsequent tests that change the
  // `mockGetDevice` return value (e.g. preset hit → preset miss).
  __resetIosPtSizeCacheForTests();
  // Reset the press mock entirely — `clearAllMocks` does not drain the
  // `mockResolvedValueOnce` / `mockRejectedValueOnce` queue, so an
  // overridden once-value from a previous test would otherwise be
  // consumed by the next test's first call. `mockReset` drops queued
  // once-values and the base implementation; we then reinstall the
  // default PRESS_NOT_ACTIONABLE base so the vast majority of tests
  // still exercise the coordinate-tap fallback without further setup.
  mockPress.mockReset();
  mockPress.mockResolvedValue({
    ok: false,
    code: 'PRESS_NOT_ACTIONABLE',
    path: '',
    actions: [],
    role: null,
    identifier: null,
    label: null,
    message: 'Element does not support AXPress',
    axErrorCode: null,
  });
  mockDumpTree.mockResolvedValue(makeNodeTree(makeNode()));
  // Default: device not found in preset table → no coordinate conversion.
  mockGetDevice.mockResolvedValue(null);
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
    expect(body.error).toBe('MISSING_REQUIRED_PARAM');
    expect(body.message).toContain('At least one query parameter');
  });

  it('returns error when element not found', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await handler('session', { label: 'NonExistent', timeout: 0 });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('APP_STATE_UNKNOWN');
    expect(body.message).toBe('Element not found');
  });

  it('returns error when element is not visible', async () => {
    const node = makeNode({ visible: false, frame: { x: 0, y: 0, width: 0, height: 0 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: 'Hidden', timeout: 0 });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('NATIVE_GESTURE_FAILED');
    expect(body.message).toContain('not visible');
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

  it('can tap a multiline label returned from the normalized query path', async () => {
    const node = makeNode({
      label: '마이\n탭 4개 중 4번째',
      identifier: 'my-tab',
      frame: { x: 10, y: 20, width: 120, height: 40 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', { label: '마이 탭 4개 중 4번째', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.element.label).toBe('마이\n탭 4개 중 4번째');
    expect(mockTap).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ label: '마이 탭 4개 중 4번째' }),
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
    expect(body.error).toBe('MISSING_REQUIRED_PARAM');
    expect(body.message).toContain('At least one query parameter');
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
    expect(body.error).toBe('NATIVE_GESTURE_FAILED');
    expect(body.message).toMatch(/finite/);
    // Infinity does not round-trip through JSON (→ null), so we just
    // confirm the element payload is surfaced with a width that is
    // no longer a usable finite number.
    expect(body.element).toMatchObject({ frame: { height: 10 } });
    expect(body.element.frame.width).toBeNull();
    expect(mockTap).not.toHaveBeenCalled();
  });
});

describe('app_tap_element — Tier 1.5 AX press', () => {
  it('routes to AX press when the element advertises the AXPress action', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockDumpTree
      .mockResolvedValueOnce(makeNodeTree(node))
      .mockResolvedValueOnce(makeNodeTree({ ...node, focused: true }));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.backend).toBe('ax-press');
    expect(body.verified).toBe(true);
    expect(body.effect).toBe('focus_changed');
    expect(body._meta).toMatchObject({
      backendKind: 'ax-press',
      headless: true,
      axActions: ['AXPress'],
    });
    // Coordinate tap backend MUST NOT be touched when AX press succeeds.
    expect(mockTap).not.toHaveBeenCalled();
    expect(mockPress).toHaveBeenCalledWith('0/1', 'test-device-id');
  });

  it('falls back to coordinate tap when AX press reports PRESS_NOT_ACTIONABLE', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Default mockPress resolution is PRESS_NOT_ACTIONABLE.

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.backend).toBe('simctl');
    expect(mockTap).toHaveBeenCalledTimes(1);
    expect(mockPress).toHaveBeenCalledTimes(1);
  });

  it('falls back to coordinate tap when AX press reports OK but no observable effect is detected', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockDumpTree
      .mockResolvedValueOnce(makeNodeTree(node))
      .mockResolvedValueOnce(makeNodeTree(node));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('NATIVE_GESTURE_FAILED');
    expect(body.message).toContain('no observable AX tree change');
    expect(body.backend).toBe('simctl');
    expect(body.verified).toBe(false);
    expect(body.effect).toBe('no_observable_change');
    expect(mockTap).toHaveBeenCalledTimes(1);
  });

  it('falls back to coordinate tap when AX press reports PRESS_FAILED', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: false,
      code: 'PRESS_FAILED',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: 'AXUIElementPerformAction returned non-success',
      axErrorCode: -25212,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.backend).toBe('simctl');
    expect(mockTap).toHaveBeenCalledTimes(1);
  });

  it('skips AX press entirely when duration > 0 (long press not supported by AXPress)', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', {
      label: 'Login',
      timeout: 0,
      duration: 1.5,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    // Long-press must never route through AX press — it has no duration
    // semantics. We expect the coordinate tap backend to be invoked and
    // AX press to never have been consulted.
    expect(mockPress).not.toHaveBeenCalled();
    expect(mockTap).toHaveBeenCalledTimes(1);
    // Duration is forwarded to the coordinate backend.
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, 1.5);
    expect(body.backend).toBe('simctl');
  });

  it('honours OPENSAFARI_DISABLE_AX_PRESS=1 to force the coordinate path', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const prev = process.env.OPENSAFARI_DISABLE_AX_PRESS;
    process.env.OPENSAFARI_DISABLE_AX_PRESS = '1';
    try {
      const result = await handler('session', { label: 'Login', timeout: 0 });
      const body = JSON.parse(result.content[0].text);

      expect(result.isError).toBeUndefined();
      expect(mockPress).not.toHaveBeenCalled();
      expect(mockTap).toHaveBeenCalledTimes(1);
      expect(body.backend).toBe('simctl');
    } finally {
      if (prev === undefined) {
        delete process.env.OPENSAFARI_DISABLE_AX_PRESS;
      } else {
        process.env.OPENSAFARI_DISABLE_AX_PRESS = prev;
      }
    }
  });

  it('falls back cleanly when the bridge cannot be spawned (BRIDGE_NOT_FOUND)', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    const bridgeErr = Object.assign(new Error('ax-bridge not found'), {
      code: 'BRIDGE_NOT_FOUND',
      name: 'AccessibilityBridgeError',
    });
    mockPress.mockRejectedValueOnce(bridgeErr);

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    // AX press failed with an infrastructure error — we should transparently
    // fall back, not propagate the failure to the MCP caller.
    expect(body.backend).toBe('simctl');
    expect(mockTap).toHaveBeenCalledTimes(1);
  });

  it('propagates non-fallback bridge errors (e.g. AX_PERMISSION_DENIED)', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    const bridgeErr = Object.assign(
      new Error('Accessibility permission not granted'),
      { code: 'AX_PERMISSION_DENIED', name: 'AccessibilityBridgeError' },
    );
    mockPress.mockRejectedValueOnce(bridgeErr);

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    // Permission denied is a setup problem the user must fix — silently
    // falling back to coordinate tap would mask that.
    expect(result.isError).toBe(true);
    expect(body.error).toBe('APP_STATE_UNKNOWN');
    expect(body.message).toMatch(/permission/i);
    expect(mockTap).not.toHaveBeenCalled();
  });

  it('surfaces axActions + warning flags in the response envelope', async () => {
    const node = makeNode({ path: '2/3/4' });
    mockQuery.mockResolvedValue(makeQueryResult([node, makeNode(), makeNode()]));
    // Before tree: node present (so beforeTarget is found). After tree: node
    // focused=true (different fingerprint) → subtree_changed → verified=true.
    mockDumpTree
      .mockResolvedValueOnce(makeNodeTree(node))
      .mockResolvedValueOnce(makeNodeTree({ ...node, focused: true }));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '2/3/4',
      actions: ['AXPress', 'AXShowMenu'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body._meta.axActions).toEqual(['AXPress', 'AXShowMenu']);
    // Without explicit `index`, 3 matches should trigger implicit-ambiguity warning.
    expect(body.warning).toMatch(/ambiguous: 3 elements matched; pressed index 0/);
  });

  // ── P1: both-missing case is unverified, coordinate fallback runs ──────────

  it('returns unverified and falls back to coordinate tap when target is absent from both before and after trees (codex P1)', async () => {
    // The node path '9/9/9' is not present in either tree returned by
    // dumpTree (both trees contain only the default '0/1' node). With the
    // old code this would incorrectly return verified=true via
    // 'target_disappeared'; with the fix it must fall through to the
    // coordinate tap backend.
    const node = makeNode({ path: '9/9/9' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Both trees contain only '0/1', not '9/9/9'.
    mockDumpTree
      .mockResolvedValueOnce(makeNodeTree(makeNode()))
      .mockResolvedValueOnce(makeNodeTree(makeNode()));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '9/9/9',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('NATIVE_GESTURE_FAILED');
    expect(body.message).toContain('no observable AX tree change');
    // Must have fallen back to the coordinate tap, not returned ax-press.
    expect(body.backend).toBe('simctl');
    expect(body.verified).toBe(false);
    expect(body.effect).toBe('no_observable_change');
    expect(mockTap).toHaveBeenCalledTimes(1);
  });

  // ── target_appeared: node absent before press, present after ──────────────

  it('returns verified=true with effect="target_appeared" when target is absent before press but present after', async () => {
    // The target node is not in the "before" tree but appears in the "after"
    // tree — indicating the tap caused it to be inserted into the AX tree
    // (e.g. a lazy-loaded or conditionally rendered element).
    const node = makeNode({ path: '0/1' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Before tree: does NOT contain the target path '0/1'.
    // After tree: DOES contain the target path '0/1'.
    const emptyTree: AXNode = {
      role: 'AXWindow',
      label: 'Test App',
      traits: [],
      frame: { x: 0, y: 0, width: 375, height: 812 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [],
    };
    mockDumpTree
      .mockResolvedValueOnce(emptyTree)
      .mockResolvedValueOnce(makeNodeTree(node));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.backend).toBe('ax-press');
    expect(body.verified).toBe(true);
    expect(body.effect).toBe('target_appeared');
    expect(mockTap).not.toHaveBeenCalled();
  });

  // ── P2: dumpTree failures are treated as best-effort, fallback still runs ──

  it('falls back to coordinate tap without error when pre-press dumpTree throws (codex P2)', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });
    // Pre-press dump throws; post-press dump succeeds but should not matter.
    mockDumpTree
      .mockRejectedValueOnce(new Error('AX timeout'))
      .mockResolvedValueOnce(makeNodeTree(node));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.backend).toBe('simctl');
    expect(mockTap).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/pre-press AX tree dump failed/),
    );

    warnSpy.mockRestore();
  });

  it('falls back to coordinate tap without error when post-press dumpTree throws (codex P2)', async () => {
    const node = makeNode();
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/1',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: 'login_btn',
      label: 'Login',
      message: null,
      axErrorCode: null,
    });
    // Pre-press dump succeeds; post-press dump throws.
    mockDumpTree
      .mockResolvedValueOnce(makeNodeTree(node))
      .mockRejectedValueOnce(new Error('AX timeout on large tree'));
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('NATIVE_GESTURE_FAILED');
    expect(body.message).toContain('no observable AX tree change');
    expect(body.backend).toBe('simctl');
    expect(body.verified).toBe(false);
    expect(body.effect).toBe('no_observable_change');
    expect(mockTap).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/post-press AX tree dump failed/),
    );

    warnSpy.mockRestore();
  });
});

describe('app_tap_element — macOS-pt → iOS-pt coordinate conversion (#693 WU3)', () => {
  it('scales tap coordinates when query result carries deviceContentMacOSPt and device is in preset table', async () => {
    // iPhone 17 Pro: macOS content area 697×1515, iOS pts 402×874.
    // AX frame: x=500, y=1000, w=100, h=50 → raw center (550, 1025) in macOS-pts.
    // Expected after conversion: x ≈ 550*(402/697) ≈ 317.07, y ≈ 1025*(874/1515) ≈ 591.53
    const node = makeNode({ frame: { x: 500, y: 1000, width: 100, height: 50 } });
    const queryResultWithMacOSPt = {
      ...makeQueryResult([node]),
      deviceContentMacOSPt: { width: 697, height: 1515 },
    };
    mockQuery.mockResolvedValue(queryResultWithMacOSPt);
    // Device lookup returns iPhone 17 Pro — name matches preset 'iphone-17-pro'.
    mockGetDevice.mockResolvedValue({ name: 'iPhone 17 Pro', udid: 'test-device-id', state: 'Booted', isAvailable: true, runtime: '', runtimeVersion: '' });
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    // Converted coordinates must differ from the raw center (550, 1025).
    expect(body.coordinates.x).toBeCloseTo(317.07, 0);
    expect(body.coordinates.y).toBeCloseTo(591.53, 0);
    // The tap backend must receive the converted coordinates.
    const tapCall = mockTap.mock.calls[0];
    expect(tapCall[1]).toBeCloseTo(317.07, 0);
    expect(tapCall[2]).toBeCloseTo(591.53, 0);
    // Log entry should mention the conversion.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/macOS-pt→iOS-pt conversion applied/),
    );

    warnSpy.mockRestore();
  });

  it('falls back to raw AX coordinates when deviceContentMacOSPt is absent (legacy bridge)', async () => {
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    // No deviceContentMacOSPt on query result.
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockGetDevice.mockResolvedValue({ name: 'iPhone 17 Pro', udid: 'test-device-id', state: 'Booted', isAvailable: true, runtime: '', runtimeVersion: '' });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    // Raw center: 100+200/2=200, 200+44/2=222
    expect(body.coordinates).toEqual({ x: 200, y: 222 });
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, undefined);
  });

  it('falls back to raw AX coordinates when device is not in the preset table', async () => {
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    const queryResultWithMacOSPt = {
      ...makeQueryResult([node]),
      deviceContentMacOSPt: { width: 697, height: 1515 },
    };
    mockQuery.mockResolvedValue(queryResultWithMacOSPt);
    // Device name does not match any preset.
    mockGetDevice.mockResolvedValue({ name: 'iPhone Unknown Model', udid: 'test-device-id', state: 'Booted', isAvailable: true, runtime: '', runtimeVersion: '' });

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    // Raw center unchanged: 200, 222
    expect(body.coordinates).toEqual({ x: 200, y: 222 });
  });

  it('falls back to raw AX coordinates when getDevice returns null (simctl failure)', async () => {
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    const queryResultWithMacOSPt = {
      ...makeQueryResult([node]),
      deviceContentMacOSPt: { width: 697, height: 1515 },
    };
    mockQuery.mockResolvedValue(queryResultWithMacOSPt);
    // getDevice returns null — simctl failure simulated.
    mockGetDevice.mockResolvedValue(null);

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    // Raw center unchanged.
    expect(body.coordinates).toEqual({ x: 200, y: 222 });
  });
});

// ── WU4: multi-device integration (.each) ────────────────────────────────────

describe('app_tap_element — macOS-pt → iOS-pt conversion (#693 WU4 multi-device)', () => {
  // Representative device sample: iPhone 17 Pro, iPhone 17e (different form
  // factor / size), and iPad Air (larger aspect ratio).
  const deviceCases = [
    {
      key: 'iphone-17-pro',
      preset: DEVICE_PRESETS['iphone-17-pro'],
      // Observed macOS-pt content width from PR #695 dump for iPhone 17 Pro.
      macOSPtW: 697,
      macOSPtH: 1515,
    },
    {
      key: 'iphone-17e',
      preset: DEVICE_PRESETS['iphone-17e'],
      // Synthetic macOS-pt size for iPhone 17e — same ~1.733× reference scale.
      macOSPtW: Math.round(DEVICE_PRESETS['iphone-17e'].w * (697 / 402)),
      macOSPtH: Math.round(DEVICE_PRESETS['iphone-17e'].h * (1515 / 874)),
    },
    {
      key: 'ipad-air',
      preset: DEVICE_PRESETS['ipad-air'],
      // Synthetic macOS-pt size for iPad Air 13-inch.
      macOSPtW: Math.round(DEVICE_PRESETS['ipad-air'].w * (697 / 402)),
      macOSPtH: Math.round(DEVICE_PRESETS['ipad-air'].h * (1515 / 874)),
    },
  ] as const;

  it.each(deviceCases)(
    'dispatches tap at correct iOS-pt coordinates for $key',
    async ({ preset, macOSPtW, macOSPtH }) => {
      // AX frame: 50% through the macOS content area on each axis.
      const axX = macOSPtW * 0.5;
      const axY = macOSPtH * 0.5;
      const node = makeNode({ frame: { x: axX - 10, y: axY - 10, width: 20, height: 20 } });
      const queryResultWithMacOSPt = {
        ...makeQueryResult([node]),
        deviceContentMacOSPt: { width: macOSPtW, height: macOSPtH },
      };
      mockQuery.mockResolvedValue(queryResultWithMacOSPt);
      mockGetDevice.mockResolvedValue({
        name: preset.name,
        udid: 'test-device-id',
        state: 'Booted' as const,
        isAvailable: true,
        runtime: '',
        runtimeVersion: '',
      });
      const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await handler('session', { label: 'Login', timeout: 0 });
      const body = JSON.parse(result.content[0].text);

      expect(body.status).toBe('tapped');

      // Expected iOS-pt center: axCenter * (iOSPt / macOSPt) = 50% of iOSPt
      const expectedX = axX * (preset.w / macOSPtW);
      const expectedY = axY * (preset.h / macOSPtH);
      expect(body.coordinates.x).toBeCloseTo(expectedX, 1);
      expect(body.coordinates.y).toBeCloseTo(expectedY, 1);

      const tapCall = mockTap.mock.calls[0];
      expect(tapCall[1]).toBeCloseTo(expectedX, 1);
      expect(tapCall[2]).toBeCloseTo(expectedY, 1);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/macOS-pt→iOS-pt conversion applied/),
      );
      warnSpy.mockRestore();
    },
  );
});

// ── WU4: explicit non-conversion regressions ──────────────────────────────────

describe('app_tap_element — explicit non-conversion regressions (#693 WU4)', () => {
  it('uses raw frame center when deviceContentMacOSPt is undefined (legacy bridge backward compat)', async () => {
    // Simulates a bridge that does not emit deviceContentMacOSPt — the
    // legacy path must not apply any scaling whatsoever.
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    // makeQueryResult produces a result with no deviceContentMacOSPt field.
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Even if a valid device is in the preset table, no conversion should run.
    mockGetDevice.mockResolvedValue({
      name: 'iPhone 17 Pro',
      udid: 'test-device-id',
      state: 'Booted' as const,
      isAvailable: true,
      runtime: '',
      runtimeVersion: '',
    });
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    // Raw center: 100 + 200/2 = 200, 200 + 44/2 = 222 — must not be scaled.
    expect(body.coordinates).toEqual({ x: 200, y: 222 });
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, undefined);
    // Conversion log line must NOT appear.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/macOS-pt→iOS-pt conversion applied/),
    );
    warnSpy.mockRestore();
  });

  it('uses raw frame center when iOS-pt size lookup returns null (unknown device)', async () => {
    // Simulates a bridge that emits deviceContentMacOSPt but the simulator
    // device name does not match any DEVICE_PRESETS entry — conversion must
    // be skipped, not produce a wrong scaled result.
    const node = makeNode({ frame: { x: 100, y: 200, width: 200, height: 44 } });
    mockQuery.mockResolvedValue({
      ...makeQueryResult([node]),
      deviceContentMacOSPt: { width: 697, height: 1515 },
    });
    // getDevice returns null — simulates simctl failure or unknown device.
    mockGetDevice.mockResolvedValue(null);

    const result = await handler('session', { label: 'Login', timeout: 0 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('tapped');
    expect(body.coordinates).toEqual({ x: 200, y: 222 });
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 200, 222, undefined);
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
