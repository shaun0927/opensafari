/**
 * Snapshot test for PR2 of issue #797.
 *
 * Verifies that each of the 12 migrated tool handlers emits the canonical
 * 5-key structured-error envelope shape on every isError path:
 *   { error, message, recoverable, suggestion, ...extras }
 *
 * We exercise the cheapest reachable error path for each tool — typically
 * a missing required param or an invalid enum value — so no real simulator
 * or AX bridge is needed.
 */

import { MCPServer } from '../../src/mcp-server';
import { ErrorCode } from '../../src/errors';

// ── shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => null }),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([]),
  })),
  getDefaultSimulatorManager: jest.fn().mockReturnValue({
    listBooted: jest.fn().mockResolvedValue([]),
    resetApp: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock('../../src/native', () => ({
  getAccessibilityBridge: () => ({ query: jest.fn(), dumpTree: jest.fn() }),
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(0),
  isLikelyChromeOnlyTree: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({ query: jest.fn(), dumpTree: jest.fn() }),
}));

jest.mock('../../src/tools/native-input-utils', () => ({
  getInputBackend: jest.fn().mockResolvedValue({
    kind: 'simhid',
    headless: true,
    sendKey: jest.fn(),
    tap: jest.fn(),
    swipe: jest.fn(),
    typeText: jest.fn(),
    keypress: jest.fn(),
  }),
  resolveDeviceId: jest.fn().mockReturnValue('device-1'),
  runInputOp: jest.fn().mockResolvedValue({ meta: {} }),
}));

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn().mockResolvedValue({
    kind: 'simhid',
    headless: true,
    sendKey: jest.fn(),
    tap: jest.fn(),
    swipe: jest.fn(),
    typeText: jest.fn(),
    keypress: jest.fn(),
  }),
}));

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return actual;
});

jest.mock('../../src/tools/native-app-context', () => ({
  activateAndClassify: jest.fn().mockResolvedValue({
    meta: {
      requestedBundleId: undefined,
      deviceId: 'device-1',
      sourceKind: 'target-app',
      heuristics: [],
      activationAttempted: false,
      activationRetries: 0,
    },
  }),
  createContextMismatchError: jest.fn().mockReturnValue(new Error('mismatch')),
}));

jest.mock('../../src/tools/mobile-context', () => ({
  classifyMobileContext: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/simulator/presets', () => ({
  DEVICE_PRESETS: {},
}));

jest.mock('../../src/tools/native-app-helpers', () => ({
  resolveDeviceId: jest.fn().mockImplementation(() => {
    throw new Error('No booted simulator found');
  }),
}));

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  })),
}));

jest.mock('../../src/simulator/proxy-manager', () => ({
  getProxyForDevice: jest.fn(),
  stopProxyForDevice: jest.fn(),
  peekProxyForDevice: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/webkit/client', () => ({
  WebKitClient: jest.fn(),
}));

jest.mock('../../src/reliability/zombie-cleanup', () => ({
  addManagedDevice: jest.fn(),
}));

jest.mock('../../src/simulator/post-boot-optimize', () => ({
  disableBackgroundServices: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/defaults', () => ({
  DEFAULT_MAX_SIMULATORS: 2,
}));

jest.mock('../../src/auth/native-manager', () => ({
  NativeAuthManager: jest.fn().mockImplementation(() => ({
    save: jest.fn(),
  })),
}));

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: jest.fn().mockReturnValue({ isConnected: () => false }),
}));

jest.mock('../../src/tools/flutter-get-route', () => ({
  __forTests: {
    ROUTE_EXPRESSION: '',
    parseRoutePayload: jest.fn().mockReturnValue({ name: null, source: 'unknown' }),
  },
}));

jest.mock('../../src/observability/capture-logs-window', () => ({
  captureLogsWindow: jest.fn().mockResolvedValue([]),
}));

// ── helper ────────────────────────────────────────────────────────────────────

interface MCPResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Assert that a tool response is a well-formed structured error envelope.
 * Returns the parsed payload for additional assertions.
 */
function assertStructuredError(
  result: MCPResult,
  expectedCode: ErrorCode,
): Record<string, unknown> {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  const payload = JSON.parse(result.content![0].text!) as Record<string, unknown>;
  // 5 required keys
  expect(payload).toHaveProperty('error');
  expect(payload).toHaveProperty('message');
  expect(payload).toHaveProperty('recoverable');
  expect(payload).toHaveProperty('suggestion');
  expect(typeof payload.suggestion).toBe('string');
  expect(typeof payload.recoverable).toBe('boolean');
  expect(payload.error).toBe(expectedCode);
  return payload;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('tier-0 error envelope shape (#797 PR2)', () => {
  let server: MCPServer;

  beforeEach(async () => {
    jest.clearAllMocks();
    server = new MCPServer();
    // Reset the simulator mock to the default (empty booted list) before each test
    const simModule = await import('../../src/simulator');
    (simModule.getDefaultSimulatorManager as jest.Mock).mockReturnValue({
      listBooted: jest.fn().mockResolvedValue([]),
      resetApp: jest.fn().mockResolvedValue({}),
    });
  });

  // 1. app-goto-screen — INVALID_URL (missing scheme)
  test('app_goto_screen: INVALID_URL on bad url', async () => {
    const { registerAppGotoScreenTool } = await import('../../src/tools/app-goto-screen');
    registerAppGotoScreenTool(server);
    const handler = server.getToolHandler('app_goto_screen')!;
    const result = await handler('s', { url: 'not-a-url' });
    assertStructuredError(result, ErrorCode.INVALID_URL);
  });

  test('app_goto_screen: INVALID_INPUT when waitFor postcondition is omitted', async () => {
    const { registerAppGotoScreenTool } = await import('../../src/tools/app-goto-screen');
    registerAppGotoScreenTool(server);
    const handler = server.getToolHandler('app_goto_screen')!;
    const result = await handler('s', { url: 'myapp://home' });
    assertStructuredError(result, ErrorCode.INVALID_INPUT);
  });

  // 1b. app-goto-screen — DEVICE_NOT_BOOTED (valid url/postcondition, no device)
  test('app_goto_screen: DEVICE_NOT_BOOTED when no simulator', async () => {
    const { registerAppGotoScreenTool } = await import('../../src/tools/app-goto-screen');
    registerAppGotoScreenTool(server);
    const handler = server.getToolHandler('app_goto_screen')!;
    // url and waitFor are valid but resolveDeviceId will return null (session mock returns null)
    const result = await handler('s', { url: 'myapp://home', waitFor: { identifier: 'home' } });
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });

  // 2. app-dismiss-overlay — INVALID_INPUT on bad mode
  test('app_dismiss_overlay: INVALID_INPUT on unknown mode', async () => {
    const { registerAppDismissOverlayTool } = await import('../../src/tools/app-dismiss-overlay');
    registerAppDismissOverlayTool(server);
    const handler = server.getToolHandler('app_dismiss_overlay')!;
    const result = await handler('s', { mode: 'BOGUS_MODE' });
    const payload = assertStructuredError(result, ErrorCode.INVALID_INPUT);
    expect(Array.isArray(payload.allowed)).toBe(true);
  });

  // 2b. app-dismiss-overlay — DEVICE_NOT_BOOTED
  test('app_dismiss_overlay: DEVICE_NOT_BOOTED when no simulator', async () => {
    const { registerAppDismissOverlayTool } = await import('../../src/tools/app-dismiss-overlay');
    registerAppDismissOverlayTool(server);
    const handler = server.getToolHandler('app_dismiss_overlay')!;
    const result = await handler('s', { mode: 'auto' });
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });

  // 3. app-dismiss-keyboard — DEVICE_NOT_BOOTED
  test('app_dismiss_keyboard: DEVICE_NOT_BOOTED when no simulator', async () => {
    const { registerAppDismissKeyboardTool } = await import('../../src/tools/app-dismiss-keyboard');
    registerAppDismissKeyboardTool(server);
    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('s', {});
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });

  // 4. app-wait-for — MISSING_REQUIRED_PARAM (no query fields)
  test('app_wait_for: MISSING_REQUIRED_PARAM when no query supplied', async () => {
    const { registerAppWaitForNativeTool } = await import('../../src/tools/app-wait-for');
    registerAppWaitForNativeTool(server);
    const handler = server.getToolHandler('app_wait_for')!;
    const result = await handler('s', {});
    assertStructuredError(result, ErrorCode.MISSING_REQUIRED_PARAM);
  });

  // 5. app-context — DEVICE_NOT_BOOTED
  test('app_context: DEVICE_NOT_BOOTED when no simulator', async () => {
    const { registerAppContextTool } = await import('../../src/tools/app-context');
    registerAppContextTool(server);
    const handler = server.getToolHandler('app_context')!;
    const result = await handler('s', {});
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });

  // 6. app-inspect — MISSING_REQUIRED_PARAM (path not provided — falsy and not '')
  test('app_inspect: MISSING_REQUIRED_PARAM when path is undefined', async () => {
    const { registerAppInspectTool } = await import('../../src/tools/app-inspect');
    registerAppInspectTool(server);
    const handler = server.getToolHandler('app_inspect')!;
    // path is required in schema but handler also guards internally
    // The guard is: `if (!elementPath && elementPath !== '')`
    // When params.path is undefined, elementPath = undefined which is falsy and !== ''
    const result = await handler('s', { path: undefined });
    assertStructuredError(result, ErrorCode.MISSING_REQUIRED_PARAM);
  });

  // 7. app-tap-element — MISSING_REQUIRED_PARAM (no query fields)
  test('app_tap_element: MISSING_REQUIRED_PARAM when no query supplied', async () => {
    const { registerAppTapElementTool } = await import('../../src/tools/app-tap-element');
    registerAppTapElementTool(server);
    const handler = server.getToolHandler('app_tap_element')!;
    const result = await handler('s', {});
    assertStructuredError(result, ErrorCode.MISSING_REQUIRED_PARAM);
  });

  // 8. app-type-element — INVALID_INPUT on bad backend
  test('app_type_element: INVALID_INPUT on unsupported backend', async () => {
    const { registerAppTypeElementTool } = await import('../../src/tools/app-type-element');
    registerAppTypeElementTool(server);
    const handler = server.getToolHandler('app_type_element')!;
    const result = await handler('s', { text: 'hello', identifier: 'field', backend: 'bad' });
    assertStructuredError(result, ErrorCode.INVALID_INPUT);
  });

  // 8b. app-type-element — MISSING_REQUIRED_PARAM (no query)
  test('app_type_element: MISSING_REQUIRED_PARAM when no query field supplied', async () => {
    const { registerAppTypeElementTool } = await import('../../src/tools/app-type-element');
    registerAppTypeElementTool(server);
    const handler = server.getToolHandler('app_type_element')!;
    const result = await handler('s', { text: 'hello' });
    assertStructuredError(result, ErrorCode.MISSING_REQUIRED_PARAM);
  });

  // 9. app-alert-handle — DEVICE_NOT_BOOTED
  test('app_alert_handle: DEVICE_NOT_BOOTED when no simulator', async () => {
    const { registerAppAlertHandleTool } = await import('../../src/tools/app-alert-handle');
    registerAppAlertHandleTool(server);
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('s', {});
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });

  // 10. app-deeplink — MISSING_REQUIRED_PARAM (no url)
  test('app_deeplink: MISSING_REQUIRED_PARAM when url is empty', async () => {
    const { registerAppDeeplinkTool } = await import('../../src/tools/app-deeplink');
    registerAppDeeplinkTool(server);
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('s', { url: '' });
    assertStructuredError(result, ErrorCode.MISSING_REQUIRED_PARAM);
  });

  // 10b. app-deeplink — INVALID_URL (no scheme)
  test('app_deeplink: INVALID_URL when url has no scheme', async () => {
    const { registerAppDeeplinkTool } = await import('../../src/tools/app-deeplink');
    registerAppDeeplinkTool(server);
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('s', { url: 'example.com/path' });
    assertStructuredError(result, ErrorCode.INVALID_URL);
  });

  // 11. device-boot — RESOURCE_EXHAUSTED when max simulators reached
  test('device_boot: RESOURCE_EXHAUSTED when max simulators reached', async () => {
    // Override the simulator mock to report 2 booted devices (= DEFAULT_MAX_SIMULATORS)
    const simModule = await import('../../src/simulator');
    (simModule.getDefaultSimulatorManager as jest.Mock).mockReturnValue({
      listBooted: jest.fn().mockResolvedValue([
        { udid: 'dev-1', name: 'iPhone 15', state: 'Booted' },
        { udid: 'dev-2', name: 'iPhone 15 Pro', state: 'Booted' },
      ]),
      boot: jest.fn(),
    });
    const { registerDeviceBootTool } = await import('../../src/tools/device-boot');
    registerDeviceBootTool(server);
    const handler = server.getToolHandler('device_boot')!;
    const result = await handler('s', { device: 'iPhone 16' });
    const payload = assertStructuredError(result, ErrorCode.RESOURCE_EXHAUSTED);
    expect(Array.isArray(payload.running)).toBe(true);
  });

  // 12. app-reset — DEVICE_NOT_BOOTED
  test('app_reset: DEVICE_NOT_BOOTED when no simulator', async () => {
    const simModule = await import('../../src/simulator');
    (simModule.getDefaultSimulatorManager as jest.Mock).mockReturnValue({
      listBooted: jest.fn().mockResolvedValue([]),
      resetApp: jest.fn().mockResolvedValue({}),
    });
    const { registerAppResetTool } = await import('../../src/tools/app-reset');
    registerAppResetTool(server);
    const handler = server.getToolHandler('app_reset')!;
    const result = await handler('s', { bundleId: 'com.example.app' });
    assertStructuredError(result, ErrorCode.DEVICE_NOT_BOOTED);
  });
});
