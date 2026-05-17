/**
 * Unit tests for app_tap safety layer (issue #644):
 *   - Device-frame bounds guard (WU2).
 *   - Post-tap foreground verification + sideEffect (WU3).
 *   - AX-aware snap path for modals (WU4).
 *   - autoReactivate recovery policy (WU5).
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppTapTool } from '../../src/tools/app-tap';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockEnsureSemanticsActive = jest.fn().mockResolvedValue(true);
const mockCountNodes = jest.fn().mockReturnValue(10);
const mockDumpTree = jest.fn();
const mockPress = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);
const mockActivateApp = jest.fn().mockResolvedValue({ activated: true, pid: 1 });
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
    press: (...args: unknown[]) => mockPress(...args),
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
  SimulatorManager: jest.fn().mockImplementation(() => ({
    activateApp: mockActivateApp,
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function appNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXWindow',
    label: 'Demo App',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXButton',
        label: 'Continue',
        traits: [],
        frame: { x: 100, y: 200, width: 100, height: 44 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/0',
      },
      {
        role: 'AXStaticText',
        label: 'Body text',
        traits: [],
        frame: { x: 50, y: 100, width: 200, height: 30 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/1',
      },
    ],
    ...overrides,
  };
}

function springboardNode(): AXNode {
  return {
    role: 'AXWindow',
    label: 'SpringBoard',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXTextField',
        label: 'spotlight-pill',
        traits: [],
        frame: { x: 10, y: 10, width: 200, height: 30 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/0',
      },
    ],
  };
}

function appWithAlert(): AXNode {
  return {
    role: 'AXWindow',
    label: 'Demo App',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXAlert',
        label: 'Permissions',
        traits: [],
        frame: { x: 60, y: 420, width: 273, height: 170 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/0',
        children: [
          {
            role: 'AXStaticText',
            label: '"Demo App" Would Like to Send You Notifications',
            traits: [],
            frame: { x: 70, y: 430, width: 250, height: 40 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/0/0',
          },
          {
            role: 'AXButton',
            label: "Don't Allow",
            traits: [],
            frame: { x: 70, y: 490, width: 120, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/0/1',
          },
          {
            role: 'AXButton',
            label: 'Allow',
            traits: [],
            frame: { x: 200, y: 490, width: 120, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/0/2',
          },
        ],
      },
    ],
  };
}

// ── Test Setup ───────────────────────────────────────────────────────────────

let handler: (
  sessionId: string,
  params: Record<string, unknown>,
) => Promise<{
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
  mockPress.mockResolvedValue({ ok: true, code: 'PRESS_OK', actions: ['AXPress'] });
  mockActivateApp.mockResolvedValue({ activated: true, pid: 1 });
  mockProbeMobileContext.mockResolvedValue({
    deviceId: 'test-device-id',
    surface: 'app_content',
    contextVerified: false,
    reason: 'stub',
    warnings: [],
    runningApps: [],
    visibleSummary: {
      buttonLabels: [],
      staticTexts: [],
      textFieldLabels: [],
      nodeCount: 0,
    },
  });
});

// ── WU2: Device-frame bounds guard ────────────────────────────────────────

describe('app_tap — device-frame bounds guard (#644 WU2)', () => {
  it('rejects taps inside the bottom home-indicator guard band', async () => {
    mockDumpTree.mockResolvedValue(appNode());

    const result = await handler('session', { x: 200, y: 850 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('TAP_OUT_OF_BOUNDS');
    expect(body.sideEffect).toBe('out_of_bounds');
    expect(body.reason).toBe('home_indicator_band');
    expect(body.dispatched).toBe(false);
    expect(mockTap).not.toHaveBeenCalled();
  });

  it('rejects taps outside the frame width', async () => {
    mockDumpTree.mockResolvedValue(appNode());

    const result = await handler('session', { x: 500, y: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.reason).toBe('x_out_of_bounds');
    expect(mockTap).not.toHaveBeenCalled();
  });

  it('lets an in-bounds tap through', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = appNode({ label: 'Changed' });
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 150, y: 250, raw: true });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.verified).toBe(true);
    jest.useRealTimers();
  });
});

// ── WU3: Post-tap foreground verification ─────────────────────────────────

describe('app_tap — post-tap foreground verification (#644 WU3)', () => {
  it('returns APP_BACKGROUNDED when SpringBoard replaces the app after a raw tap', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = springboardNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 150, y: 250, raw: true });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('APP_BACKGROUNDED');
    expect(body.sideEffect).toBe('app_backgrounded');
    expect(body.foregroundBefore).toBe('target-app');
    expect(body.foregroundAfter).toBe('springboard');
    expect(body.recovered).toBe(false);
    jest.useRealTimers();
  });

  it('suppresses the soft failure when requireInApp=false', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = springboardNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', {
      x: 150,
      y: 250,
      raw: true,
      requireInApp: false,
    });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('tapped');
    expect(body.sideEffect).toBe('app_backgrounded');
    expect(body.foregroundAfter).toBe('springboard');
    jest.useRealTimers();
  });

  it('reports foregroundBefore/foregroundAfter on a normal in-app tap', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = appNode({ label: 'Changed' });
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 150, y: 250, raw: true });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.foregroundBefore).toBe('target-app');
    expect(body.foregroundAfter).toBe('target-app');
    expect(body.sideEffect).toBe('none');
    jest.useRealTimers();
  });
});

// ── WU4: AX-aware snap path ───────────────────────────────────────────────

describe('app_tap — AX snap for modals (#644 WU4)', () => {
  it('snaps a near-button coordinate onto the AXButton centre when a modal is present', async () => {
    jest.useFakeTimers();
    const before = appWithAlert();
    const after = appNode(); // alert dismissed → tree changed
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    // Coordinate ~15 px off the "Allow" centre (260, 512) but within 24 px radius.
    const promise = handler('session', { x: 255, y: 500 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.sideEffect).toBe('ax_snapped');
    expect(body.snapped).toBeDefined();
    expect(body.snapped.elementPath).toBe('0/0/2');
    expect(body.snapped.from).toEqual({ x: 255, y: 500 });
    expect(body.backend).toBe('ax-press');
    expect(mockPress).toHaveBeenCalledWith('0/0/2', 'test-device-id');
    // When AX press succeeds, we should not also fire a coordinate tap.
    expect(mockTap).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('presses a non-modal AXButton when the coordinate falls inside its frame', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = appNode({ label: 'Demo App After Press' });
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 150, y: 220 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.sideEffect).toBe('ax_snapped');
    expect(body.snapped.elementPath).toBe('0/0');
    expect(body.backend).toBe('ax-press');
    expect(mockPress).toHaveBeenCalledWith('0/0', 'test-device-id');
    expect(mockTap).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('prefers the smallest containing non-modal AXButton for nested controls', async () => {
    jest.useFakeTimers();
    const before = appNode({
      children: [
        {
          role: 'AXButton',
          label: 'Card',
          traits: [],
          frame: { x: 20, y: 180, width: 320, height: 180 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0/card',
          children: [
            {
              role: 'AXButton',
              label: 'Buy',
              traits: [],
              frame: { x: 250, y: 300, width: 70, height: 44 },
              visible: true,
              enabled: true,
              focused: false,
              path: '0/card/buy',
            },
          ],
        },
      ],
    });
    const after = appNode({ label: 'Nested Button Pressed' });
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 275, y: 320 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.snapped.elementPath).toBe('0/card/buy');
    expect(mockPress).toHaveBeenCalledWith('0/card/buy', 'test-device-id');
    expect(mockTap).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not snap when raw=true is explicit', async () => {
    jest.useFakeTimers();
    const before = appWithAlert();
    const after = appNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 255, y: 500, raw: true });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.snapped).toBeUndefined();
    expect(body.sideEffect).not.toBe('ax_snapped');
    expect(mockPress).not.toHaveBeenCalled();
    expect(mockTap).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not snap when the coordinate is outside snapRadiusPx', async () => {
    jest.useFakeTimers();
    const before = appWithAlert();
    const after = appNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', { x: 100, y: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.snapped).toBeUndefined();
    expect(body.sideEffect).not.toBe('ax_snapped');
    expect(mockPress).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('falls back to coordinate dispatch when AX press returns not-actionable', async () => {
    jest.useFakeTimers();
    const before = appWithAlert();
    const after = appNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);
    mockPress.mockResolvedValue({
      ok: false,
      code: 'PRESS_NOT_ACTIONABLE',
      actions: [],
    });

    const promise = handler('session', { x: 255, y: 500 });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.sideEffect).toBe('ax_snapped');
    expect(body.backend).toBe('simctl');
    expect(mockTap).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

// ── WU5: autoReactivate recovery ──────────────────────────────────────────

describe('app_tap — autoReactivate (#644 WU5)', () => {
  it('activates the expected bundle when the tap backgrounds the app', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = springboardNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', {
      x: 150,
      y: 250,
      raw: true,
      autoReactivate: true,
      expectedBundle: 'com.example.target',
    });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('APP_BACKGROUNDED');
    expect(body.recovered).toBe(true);
    expect(mockActivateApp).toHaveBeenCalledWith('test-device-id', 'com.example.target');
    jest.useRealTimers();
  });

  it('reports recovered=false when autoReactivate is off', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = springboardNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', {
      x: 150,
      y: 250,
      raw: true,
      expectedBundle: 'com.example.target',
    });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.recovered).toBe(false);
    expect(mockActivateApp).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not call activateApp when expectedBundle is missing', async () => {
    jest.useFakeTimers();
    const before = appNode();
    const after = springboardNode();
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValue(after);

    const promise = handler('session', {
      x: 150,
      y: 250,
      raw: true,
      autoReactivate: true,
    });
    await jest.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(result.content[0].text);

    expect(body.recovered).toBe(false);
    expect(mockActivateApp).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
