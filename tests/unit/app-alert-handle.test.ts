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
    expect(text.error).toBe('INVALID_ACTION');
    expect(text.message).toContain('"close"');
  });

  test('returns MISSING_PARAMS when neither action nor buttonLabel provided', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('MISSING_PARAMS');
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
    expect(text.error).toBe('ALERT_HANDLE_FAILED');
    expect(text.message).toContain('Failed to accept alert');
  });

  // ── AX-press path (label-based) ───────────────────────────────────────────

  test('presses button by buttonLabel (exact match)', async () => {
    mockDumpTree.mockResolvedValue(makeTree(['Cancel', 'OK']));
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
    expect(text._meta._telemetry[0].backend).toBe('ax-press');
    // should NOT have called sendKey
    expect(mockSendKey).not.toHaveBeenCalled();
  });

  test('presses button case-insensitively', async () => {
    mockDumpTree.mockResolvedValue(makeTree(['Allow', "Don't Allow"]));
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
    mockDumpTree.mockResolvedValue(makeTree(['Cancel', 'Allow']));
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
    expect(text.error).toBe('NO_MATCHING_BUTTON');
    expect(text.visibleLabels).toContain('Continue');
    expect(text.visibleLabels).toContain('Go Back');
  });

  test('buttonLabels takes precedence over buttonLabel', async () => {
    // When both are supplied, buttonLabels wins
    mockDumpTree.mockResolvedValue(makeTree(['Allow', 'Deny']));
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
    expect(text.error).toBe('ALERT_HANDLE_FAILED');
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
