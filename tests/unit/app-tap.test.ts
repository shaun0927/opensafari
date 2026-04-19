/**
 * Unit tests for app_tap tool.
 *
 * Covers:
 *   - Semantics activation called before pre-tap dumpTree (Codex P1)
 *   - Sparse tree (< 5 nodes) after activation returns verification_unavailable, not TAP_NO_EFFECT
 *   - dumpTree failure → verification_unavailable (not error)
 *   - Post-tap context probe (verifyContext / expectedBundle)
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppTapTool } from '../../src/tools/app-tap';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockEnsureSemanticsActive = jest.fn().mockResolvedValue(true);
const mockCountNodes = jest.fn().mockReturnValue(10);
const mockDumpTree = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);
const mockProbeMobileContext = jest.fn();

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: (...args: unknown[]) => mockEnsureSemanticsActive(...args),
  countNodes: (...args: unknown[]) => mockCountNodes(...args),
}));

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: (...args: unknown[]) => mockDumpTree(...args),
  }),
}));

jest.mock('../../src/tools/native-input-utils', () => ({
  resolveDeviceId: jest.fn(() => 'test-device-id'),
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    tap: mockTap,
  })),
  runInputOp: jest.fn(async (_backend: unknown, _deviceId: unknown, fn: () => unknown) => {
    await fn();
    return { meta: { backendKind: 'simctl' } };
  }),
}));

jest.mock('../../src/tools/app-context', () => ({
  probeMobileContext: (...args: unknown[]) => mockProbeMobileContext(...args),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({})),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXWindow',
    label: 'App',
    traits: [],
    frame: { x: 0, y: 0, width: 375, height: 812 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      { role: 'AXButton', label: 'OK', traits: [], frame: { x: 100, y: 200, width: 100, height: 44 }, visible: true, enabled: true, focused: false, path: '0/0' },
      { role: 'AXStaticText', label: 'Hello', traits: [], frame: { x: 50, y: 100, width: 200, height: 30 }, visible: true, enabled: true, focused: false, path: '0/1' },
      { role: 'AXTextField', label: 'Name', traits: [], frame: { x: 20, y: 300, width: 300, height: 44 }, visible: true, enabled: true, focused: false, path: '0/2' },
      { role: 'AXScrollView', label: '', traits: [], frame: { x: 0, y: 400, width: 375, height: 400 }, visible: true, enabled: true, focused: false, path: '0/3' },
    ],
    ...overrides,
  };
}

// ── Test Setup ───────────────────────────────────────────────────────────────

let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

beforeAll(() => {
  const server = {
    registerTool: jest.fn((_schema: unknown, fn: unknown) => {
      handler = fn as typeof handler;
    }),
  } as unknown as MCPServer;
  registerAppTapTool(server);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockEnsureSemanticsActive.mockResolvedValue(true);
  mockCountNodes.mockReturnValue(10);
  mockTap.mockResolvedValue(undefined);
  mockProbeMobileContext.mockResolvedValue({
    deviceId: 'test-device-id',
    surface: 'app_content',
    contextVerified: false,
    expectedBundle: 'com.example.target',
    expectedBundleMatch: 'matched',
    expectedBundleMatchConfidence: 'heuristic',
    reason: 'heuristic test',
    warnings: [],
    runningApps: [{ bundleId: 'com.example.target', pid: 123 }],
    visibleSummary: {
      buttonLabels: ['Continue'],
      staticTexts: ['Welcome'],
      textFieldLabels: [],
      nodeCount: 2,
    },
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('app_tap — semantics activation (Codex P1)', () => {
  it('calls ensureSemanticsActive before pre-tap dumpTree', async () => {
    jest.useFakeTimers();
    const before = makeNode();
    const after = makeNode({ label: 'App Changed' });
    mockDumpTree
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);

    const promise = handler('session', { x: 100, y: 200 });
    await jest.runAllTimersAsync();
    await promise;

    // ensureSemanticsActive must be called before any dumpTree call
    const ensureOrder = mockEnsureSemanticsActive.mock.invocationCallOrder[0];
    const dumpOrder = mockDumpTree.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(dumpOrder);
    jest.useRealTimers();
  });

  it('passes deviceId to ensureSemanticsActive', async () => {
    jest.useFakeTimers();
    const tree = makeNode();
    mockDumpTree.mockResolvedValue(tree);

    const promise = handler('session', { x: 50, y: 100 });
    await jest.runAllTimersAsync();
    await promise;

    expect(mockEnsureSemanticsActive).toHaveBeenCalledWith('test-device-id');
    jest.useRealTimers();
  });

  it('returns verification_unavailable (not TAP_NO_EFFECT) when tree is sparse after activation', async () => {
    // ensureSemanticsActive returns true but tree has < 5 nodes → sparse
    mockEnsureSemanticsActive.mockResolvedValue(true);
    mockCountNodes.mockReturnValue(3); // sparse
    mockDumpTree.mockResolvedValue(makeNode());

    const result = await handler('session', { x: 100, y: 200 });
    const body = JSON.parse(result.content[0].text);

    // Must NOT be TAP_NO_EFFECT — must degrade to verification_unavailable
    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.effect).toBe('verification_unavailable');
    expect(body.verified).toBe(false);
  });

  it('returns verification_unavailable when ensureSemanticsActive returns false', async () => {
    // Semantics did not activate — skip dumpTree entirely
    mockEnsureSemanticsActive.mockResolvedValue(false);

    const result = await handler('session', { x: 100, y: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.effect).toBe('verification_unavailable');
    // dumpTree should never be called when semantics did not activate
    expect(mockDumpTree).not.toHaveBeenCalled();
  });

  it('returns verification_unavailable when ensureSemanticsActive throws', async () => {
    mockEnsureSemanticsActive.mockRejectedValue(new Error('bridge failure'));

    const result = await handler('session', { x: 100, y: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.effect).toBe('verification_unavailable');
  });
});

describe('app_tap — basic behaviour', () => {
  it('returns error for non-finite x', async () => {
    const result = await handler('session', { x: NaN, y: 100 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/finite/);
  });

  it('returns error for non-finite y', async () => {
    const result = await handler('session', { x: 100, y: Infinity });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/finite/);
  });

  it('returns tapped with verified: true when tree changes', async () => {
    jest.useFakeTimers();

    const before = makeNode();
    const after = makeNode({ label: 'Changed' });
    mockDumpTree
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);

    const promise = handler('session', { x: 50, y: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.verified).toBe(true);
    expect(body.x).toBe(50);
    expect(body.y).toBe(100);

    jest.useRealTimers();
  });
});

describe('app_tap — post-tap context probe', () => {
  it('returns postInputContext when verifyContext is enabled and AX verification unavailable', async () => {
    // Make AX verification unavailable so context probe runs
    mockEnsureSemanticsActive.mockResolvedValue(false);

    const result = await handler('session', {
      x: 100,
      y: 200,
      verifyContext: true,
      settleMs: 0,
      expectedBundle: 'com.example.target',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('tapped');
    expect(body.effect).toBe('verification_unavailable');
    expect(body.postInputContext.surface).toBe('app_content');
    expect(mockProbeMobileContext).toHaveBeenCalledWith({
      deviceId: 'test-device-id',
      expectedBundle: 'com.example.target',
      manager: expect.any(Object),
    });
  });

  it('adds warning when expected bundle is not matched', async () => {
    mockEnsureSemanticsActive.mockResolvedValue(false);
    mockProbeMobileContext.mockResolvedValueOnce({
      deviceId: 'test-device-id',
      surface: 'springboard_like',
      contextVerified: true,
      inferredBundleId: 'com.apple.springboard',
      expectedBundle: 'com.example.target',
      expectedBundleMatch: 'mismatch',
      expectedBundleMatchConfidence: 'verified',
      reason: 'springboard',
      warnings: [],
      runningApps: [],
      visibleSummary: {
        buttonLabels: ['Safari'],
        staticTexts: [],
        textFieldLabels: [],
        nodeCount: 1,
      },
    });

    const result = await handler('session', {
      x: 100,
      y: 200,
      expectedBundle: 'com.example.target',
      settleMs: 0,
    });
    const body = JSON.parse(result.content[0].text);
    const warningMismatch = JSON.parse(body.warning);
    expect(warningMismatch.code).toBe('POST_TAP_CONTEXT_MISMATCH');
    expect(warningMismatch.message).toContain('Post-tap context did not confirm expected bundle');
  });

  it('returns tap success with warning when post-tap context probe throws', async () => {
    mockEnsureSemanticsActive.mockResolvedValue(false);
    mockProbeMobileContext.mockRejectedValueOnce(new Error('AX bridge unavailable'));

    const result = await handler('session', {
      x: 100,
      y: 200,
      verifyContext: true,
      settleMs: 0,
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('tapped');
    const warningObj = JSON.parse(body.warning);
    expect(warningObj.code).toBe('POST_TAP_CONTEXT_PROBE_FAILED');
    expect(warningObj.reason).toBe('AX bridge unavailable');
    expect(body.postInputContext).toBeUndefined();
  });
});
