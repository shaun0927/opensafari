import { MCPServer } from '../../src/mcp-server';
import { registerAppAlertHandleTool } from '../../src/tools/app-alert-handle';

// ── Mocks ──

const mockSendKey = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    tap: jest.fn(),
    swipe: jest.fn(),
    typeText: jest.fn(),
    keypress: jest.fn(),
    sendKey: mockSendKey,
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
    getSimctl: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(''),
    }),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

// Mock the accessibility bridge for label-matching path
const mockDumpTree = jest.fn();
const mockPress = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: jest.fn(() => ({
    dumpTree: mockDumpTree,
    press: mockPress,
    query: jest.fn(),
    inspect: jest.fn(),
  })),
}));

// Access mocked constructors via import (already mocked above)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SimulatorManager } = require('../../src/simulator');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSessionManager } = require('../../src/session-manager');

// Helper to parse response text
function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ── Fake AX tree ──

/** Build a minimal AX tree with named buttons */
function makeTree(buttonLabels: string[]) {
  return {
    role: 'AXWindow',
    label: undefined,
    traits: [],
    frame: { x: 0, y: 0, width: 375, height: 812 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: buttonLabels.map((label, i) => ({
      role: 'AXButton',
      label,
      traits: [],
      frame: { x: 0, y: i * 44, width: 375, height: 44 },
      visible: true,
      enabled: true,
      focused: false,
      path: String(i),
      children: undefined,
    })),
  };
}

function makeModalTree(buttonLabels: string[]) {
  return {
    role: 'AXWindow',
    label: undefined,
    traits: [],
    frame: { x: 0, y: 0, width: 375, height: 812 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXGroup',
        label: undefined,
        traits: [],
        frame: { x: 0, y: 0, width: 375, height: 812 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0',
        children: [
          {
            role: 'AXButton',
            label: 'Home',
            traits: [],
            frame: { x: 0, y: 700, width: 60, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/0',
          },
          {
            role: 'AXButton',
            label: 'Save Screen',
            traits: [],
            frame: { x: 80, y: 700, width: 80, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/1',
          },
        ],
      },
      {
        role: 'AXGroup',
        label: undefined,
        traits: [],
        frame: { x: 40, y: 280, width: 295, height: 180 },
        visible: true,
        enabled: true,
        focused: false,
        path: '1',
        children: [
          {
            role: 'AXStaticText',
            label: 'Allow notifications?',
            traits: ['text'],
            frame: { x: 60, y: 300, width: 200, height: 24 },
            visible: true,
            enabled: true,
            focused: false,
            path: '1/0',
          },
          {
            role: 'AXStaticText',
            label: 'This app wants to notify you.',
            traits: ['text'],
            frame: { x: 60, y: 330, width: 220, height: 24 },
            visible: true,
            enabled: true,
            focused: false,
            path: '1/1',
          },
          ...buttonLabels.map((label, i) => ({
            role: 'AXButton',
            label,
            traits: [],
            frame: { x: 60 + i * 110, y: 390, width: 100, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: `1/${i + 2}`,
            children: undefined,
          })),
        ],
      },
    ],
  };
}

// ── Tests ──

describe('app_alert_handle tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppAlertHandleTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendKey.mockResolvedValue(undefined);
    mockPress.mockResolvedValue({ ok: true, code: 'OK', path: '0', actions: ['AXPress'], role: 'AXButton', identifier: null, label: 'OK', message: null, axErrorCode: null });

    // Re-setup default mock returns after clearAllMocks
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(''),
      }),
    }));
    getSessionManager.mockReturnValue({
      getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
    });
    mockDumpTree.mockResolvedValue(makeTree(['Cancel', 'OK']));
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_alert_handle');
  });

  // ── Keyboard path (action-only, backward compat) ──────────────────────────

  test('accepts an alert via sendKey Return', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });
    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.action).toBe('accept');
    expect(text.method).toBe('input_backend');
    expect(text.deviceId).toBe('TEST-UDID-1234');
    expect(text._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'TEST-UDID-1234' });
  });

  test('dismisses an alert via sendKey Escape', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'dismiss' });
    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.action).toBe('dismiss');
    expect(text.method).toBe('input_backend');
  });

  test('sends correct key for accept (Return)', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'accept' });
    expect(mockSendKey).toHaveBeenCalledWith('TEST-UDID-1234', 'Return');
  });

  test('sends correct key for dismiss (Escape)', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'dismiss' });
    expect(mockSendKey).toHaveBeenCalledWith('TEST-UDID-1234', 'Escape');
  });

  test('rejects invalid action', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'close' });
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('INVALID_INPUT');
    expect(text.message).toContain('"close"');
  });

  test('returns MISSING_PARAMS when neither action nor buttonLabel provided', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('MISSING_REQUIRED_PARAM');
  });

  test('returns error when no device is booted', async () => {
    getSessionManager.mockReturnValue({
      getSoleDeviceId: jest.fn().mockReturnValue(null),
    });
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
      getSimctl: jest.fn().mockReturnValue({ exec: jest.fn() }),
    }));

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('DEVICE_NOT_BOOTED');
  });

  test('uses explicit deviceId when provided', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'accept', deviceId: 'CUSTOM-UDID' });
    expect(mockSendKey).toHaveBeenCalledWith('CUSTOM-UDID', 'Return');
  });

  test('returns error when sendKey fails', async () => {
    mockSendKey.mockRejectedValue(new Error('sendkey not supported'));

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });

    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_NO_EFFECT');
    expect(text.message).toContain('Failed to accept alert');
  });

  // ── AX-press path (label-based) ───────────────────────────────────────────

  test('presses button by buttonLabel (exact match)', async () => {
    mockDumpTree
      .mockResolvedValueOnce(makeTree(['Cancel', 'OK']))
      .mockResolvedValueOnce(makeTree(['Cancel']));
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '1', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'OK', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: 'OK' });

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.method).toBe('ax-press');
    expect(text.buttonLabel).toBe('OK');
    expect(text.verified).toBe(true);
    expect(text._meta._telemetry[0].backend).toBe('ax-press');
    // should NOT have called sendKey
    expect(mockSendKey).not.toHaveBeenCalled();
  });

  test('presses button case-insensitively', async () => {
    mockDumpTree
      .mockResolvedValueOnce(makeTree(['Allow', "Don't Allow"]))
      .mockResolvedValueOnce(makeTree(["Don't Allow"]));
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '0', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'Allow', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: 'allow' }); // lowercase

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.buttonLabel).toBe('Allow');
  });

  test('respects multi-label priority order', async () => {
    // tree has both "Cancel" (idx 0) and "Allow" (idx 1)
    // buttonLabels: ['Allow', 'Cancel'] → priority 0 = Allow → should match Allow first
    mockDumpTree
      .mockResolvedValueOnce(makeTree(['Cancel', 'Allow']))
      .mockResolvedValueOnce(makeTree(['Cancel']));
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '1', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'Allow', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabels: ['Allow', 'Cancel'] });

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.buttonLabel).toBe('Allow');
    // The pressed path should correspond to 'Allow' (index 1 in tree)
    expect(mockPress).toHaveBeenCalledWith('1', 'TEST-UDID-1234');
  });

  test('returns NO_MATCHING_BUTTON error with visible titles when no label matches', async () => {
    mockDumpTree.mockResolvedValue(makeTree(['Continue', 'Go Back']));

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: 'OK' });

    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_NO_EFFECT');
    expect(text.visibleLabels).toContain('Continue');
    expect(text.visibleLabels).toContain('Go Back');
  });

  test('returns NO_MATCHING_BUTTON labels from the modal subtree instead of underlying app buttons', async () => {
    mockDumpTree.mockResolvedValue(
      makeModalTree(['취소', '계속']),
    );

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: '허용 안 함' });

    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_NO_EFFECT');
    expect(text.visibleLabels).toContain('취소');
    expect(text.visibleLabels).toContain('계속');
    expect(text.visibleLabels).not.toContain('Home');
    expect(text.visibleLabels).not.toContain('Save Screen');
  });

  test('buttonLabels takes precedence over buttonLabel', async () => {
    // When both are supplied, buttonLabels wins
    mockDumpTree
      .mockResolvedValueOnce(makeTree(['Allow', 'Deny']))
      .mockResolvedValueOnce(makeTree(['Deny']));
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '0', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'Allow', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    // buttonLabels = ['Allow'], buttonLabel = 'Deny'
    const result = await handler('test', { buttonLabels: ['Allow'], buttonLabel: 'Deny' });

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.buttonLabel).toBe('Allow');
  });

  test('returns error when AX press fails with PRESS_FAILED', async () => {
    mockDumpTree.mockResolvedValue(makeTree(['OK']));
    mockPress.mockResolvedValue({
      ok: false, code: 'PRESS_FAILED', path: '0', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'OK', message: 'AXPress returned error', axErrorCode: -25204,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: 'OK' });

    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_NO_EFFECT');
  });

  test('returns ALERT_HANDLE_NO_EFFECT when the same alert button is still present after AX press', async () => {
    // Use fake timers so the 1200ms poll loop completes instantly.
    jest.useFakeTimers();

    // Every dumpTree call returns the same unchanged tree.
    mockDumpTree.mockResolvedValue(makeTree(['취소', '계속']));
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '1', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: '계속', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const resultPromise = handler('test', { buttonLabel: '계속' });

    // Advance time past the full poll window so all setTimeout calls resolve.
    await jest.runAllTimersAsync();

    const result = await resultPromise;

    jest.useRealTimers();

    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_NO_EFFECT');
    expect(text.verified).toBe(false);
    expect(text.effect).toBe('no_observable_change');
  });

  // ── P1: full-tree fallback when subtree misses the button ────────────────

  test('falls back to full AX tree when alert subtree does not contain the requested button', async () => {
    // Build a tree where findLikelyAlertSubtree will pick the compact modal
    // group (path '1') but the actual target button lives in path '0' (the
    // wider app chrome that the heuristic rejects as non-modal).
    const fullTree = {
      role: 'AXWindow',
      label: undefined,
      traits: [],
      frame: { x: 0, y: 0, width: 375, height: 812 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [
        // App-chrome group: has a text node + a button → qualifies as compact
        // modal candidate but our target "Continue" lives here.
        {
          role: 'AXGroup',
          label: undefined,
          traits: [],
          frame: { x: 0, y: 0, width: 375, height: 812 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0',
          children: [
            {
              role: 'AXStaticText',
              label: 'Welcome',
              traits: ['text'],
              frame: { x: 40, y: 100, width: 200, height: 24 },
              visible: true,
              enabled: true,
              focused: false,
              path: '0/0',
            },
            {
              role: 'AXButton',
              label: 'Continue',
              traits: [],
              frame: { x: 40, y: 200, width: 100, height: 44 },
              visible: true,
              enabled: true,
              focused: false,
              path: '0/1',
              children: undefined,
            },
          ],
        },
        // Compact modal: text + button but does NOT contain 'Continue'.
        // findLikelyAlertSubtree should prefer this (fewer total nodes).
        {
          role: 'AXGroup',
          label: undefined,
          traits: [],
          frame: { x: 40, y: 280, width: 295, height: 180 },
          visible: true,
          enabled: true,
          focused: false,
          path: '1',
          children: [
            {
              role: 'AXStaticText',
              label: 'Confirm?',
              traits: ['text'],
              frame: { x: 60, y: 300, width: 200, height: 24 },
              visible: true,
              enabled: true,
              focused: false,
              path: '1/0',
            },
            {
              role: 'AXButton',
              label: 'Cancel',
              traits: [],
              frame: { x: 60, y: 390, width: 100, height: 44 },
              visible: true,
              enabled: true,
              focused: false,
              path: '1/1',
              children: undefined,
            },
          ],
        },
      ],
    };

    // Before tree has 'Continue'; after tree has it gone (press succeeded).
    const afterTree = {
      ...fullTree,
      children: [fullTree.children[1]], // only the modal remains
    };

    mockDumpTree
      .mockResolvedValueOnce(fullTree)
      .mockResolvedValueOnce(afterTree);
    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '0/1', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: 'Continue', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { buttonLabel: 'Continue' });

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.buttonLabel).toBe('Continue');
    expect(mockPress).toHaveBeenCalledWith('0/1', 'TEST-UDID-1234');
  });

  // ── P2: poll loop resolves early on state change ──────────────────────────

  test('poll loop succeeds when alert dismisses on a later snapshot (not the first)', async () => {
    jest.useFakeTimers();

    const beforeTree = makeTree(['취소', '계속']);
    const unchangedTree = makeTree(['취소', '계속']); // first poll: no change
    const dismissedTree = makeTree(['취소']);           // second poll: button gone

    mockDumpTree
      .mockResolvedValueOnce(beforeTree)   // initial dump before press
      .mockResolvedValueOnce(unchangedTree) // first post-press snapshot
      .mockResolvedValueOnce(dismissedTree); // second post-press snapshot → change

    mockPress.mockResolvedValue({
      ok: true, code: 'OK', path: '1', actions: ['AXPress'],
      role: 'AXButton', identifier: null, label: '계속', message: null, axErrorCode: null,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const resultPromise = handler('test', { buttonLabel: '계속' });

    // Advance timers to let the poll loop iterate.
    await jest.runAllTimersAsync();

    const result = await resultPromise;

    jest.useRealTimers();

    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.verified).toBe(true);
    // button_disappeared because '계속' (path '1') is gone in the after tree
    expect(text.effect).toBe('button_disappeared');
  });

  test('backward-compat: action=accept with no labels uses keyboard path', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });

    // Must NOT call dumpTree
    expect(mockDumpTree).not.toHaveBeenCalled();
    expect(mockSendKey).toHaveBeenCalledWith('TEST-UDID-1234', 'Return');

    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.method).toBe('input_backend');
  });
});
