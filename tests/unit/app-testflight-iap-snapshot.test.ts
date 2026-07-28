import { MCPServer } from '../../src/mcp-server';
import { ErrorCode } from '../../src/errors';

const collectAppSessionStateMock = jest.fn();
const collectDebugBundleMock = jest.fn();
const listAppsMock = jest.fn();

jest.mock('../../src/tools/app-state-snapshot', () => {
  const actual = jest.requireActual('../../src/tools/app-state-snapshot');
  return {
    ...actual,
    collectAppSessionState: (...args: unknown[]) => collectAppSessionStateMock(...args),
  };
});

jest.mock('../../src/tools/debug-bundle-collect', () => {
  const actual = jest.requireActual('../../src/tools/debug-bundle-collect');
  return {
    ...actual,
    collectDebugBundle: (...args: unknown[]) => collectDebugBundleMock(...args),
  };
});

jest.mock('../../src/native/simctl-backend', () => ({
  SimctlNativeBackend: jest.fn().mockImplementation(() => ({
    listApps: listAppsMock,
  })),
}));

function appState(visibleLabels: string[]) {
  return {
    schemaVersion: '1',
    collectedAt: '2026-06-24T00:00:00.000Z',
    device: { id: 'D1', name: 'iPhone 15', booted: true },
    app: {
      expectedBundleId: 'com.example.app',
      inferredForegroundBundleId: 'com.apple.TestFlight',
      expectedBundleMatched: false,
      contextVerified: true,
      classification: 'OTHER_APP_FOREGROUND',
      reason: 'TestFlight appears foregrounded',
      warnings: [],
    },
    ui: {
      visibleSummary: visibleLabels.map((label) => ({ role: 'AXButton', label })),
      modalHints: [],
      alertHints: [],
      overlayHints: [],
    },
    confidence: 'heuristic',
    recoveryHints: [],
  };
}

function debugBundle() {
  return {
    schemaVersion: '1',
    collectedAt: '2026-06-24T00:01:00.000Z',
    device: { udid: 'D1', name: 'iPhone 15', state: 'Booted' },
    session: { soleDeviceId: 'D1' },
    diagnose: { memory: { rss_mb: 10, peak_rss_mb: 10, heap_used_mb: 1, heap_total_mb: 2, sample_count: 1 } },
    screenshot: { path: '/tmp/opensafari-debug/b1/screenshot.png', bytes: 3 },
    ax: { rootRole: 'AXApplication', childCount: 1, depth: 3, path: '/tmp/opensafari-debug/b1/ax-tree.json' },
    logs: { tail: 'Bearer [REDACTED]', lineCount: 1, window: '5m', path: '/tmp/opensafari-debug/b1/logs.txt', redactionTags: ['logs.bearer'] },
    crashes: [],
    flutter: { connected: false },
    network: { skipped: true },
    actionTrace: [],
    redactions: { applied: ['logs.bearer'], policy: 'default-v1' },
  };
}

function parseToolResult(result: { content?: Array<{ text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text ?? '{}');
}

async function callTool(params: Record<string, unknown>) {
  const { registerAppTestFlightIapSnapshotTool } = await import('../../src/tools/app-testflight-iap-snapshot');
  const server = new MCPServer();
  registerAppTestFlightIapSnapshotTool(server);
  return server.getToolHandler('app_testflight_iap_snapshot')!('s', params);
}

describe('app_testflight_iap_snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    collectAppSessionStateMock.mockResolvedValue(appState(['TestFlight', 'Install']));
    listAppsMock.mockResolvedValue([
      { bundleId: 'com.apple.TestFlight', displayName: 'TestFlight' },
      { bundleId: 'com.example.app', displayName: 'Example' },
    ]);
    collectDebugBundleMock.mockResolvedValue(debugBundle());
  });

  it('reports classifier state from mocked AX summaries', async () => {
    const result = await callTool({ expectedAppBundleId: 'com.example.app', maxVisibleNodes: 8, maxDepth: 4 });
    const payload = parseToolResult(result);

    expect(payload.schemaVersion).toBe('1');
    expect(payload.device).toMatchObject({ id: 'D1' });
    expect(payload.expectedAppBundleId).toBe('com.example.app');
    expect(payload.testflightBundleId).toBe('com.apple.TestFlight');
    expect(payload.installedApps).toMatchObject({
      available: true,
      testflightInstalled: true,
      expectedAppInstalled: true,
    });
    expect(payload.foreground).toMatchObject({
      inferredForegroundBundleId: 'com.apple.TestFlight',
      contextVerified: true,
    });
    expect(payload.classifier).toMatchObject({
      phase: 'TESTFLIGHT_INSTALL_AVAILABLE',
      blocker: 'INSTALL_REQUIRED',
      confidence: 'high',
    });
    expect(payload.recoveryHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'app_activate', destructive: false }),
        expect.objectContaining({ action: 'debug_bundle_collect', destructive: false }),
      ]),
    );
    expect(collectAppSessionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedBundleId: 'com.example.app',
      includeFlutter: false,
      includeWebView: false,
      maxVisibleNodes: 8,
      maxDepth: 4,
    }));
  });

  it('does not collect a debug bundle when includeEvidence is false', async () => {
    const result = await callTool({ includeEvidence: false });
    const payload = parseToolResult(result);

    expect(collectDebugBundleMock).not.toHaveBeenCalled();
    expect(payload.debugBundle).toBeUndefined();
  });

  it('attaches an existing debug-bundle path summary when includeEvidence is true', async () => {
    const result = await callTool({ expectedAppBundleId: 'com.example.app', includeEvidence: true });
    const payload = parseToolResult(result);

    expect(collectDebugBundleMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'D1',
      bundleId: 'com.example.app',
      includeNetwork: false,
    }));
    expect(payload.debugBundle).toMatchObject({
      schemaVersion: '1',
      artifactDir: '/tmp/opensafari-debug/b1',
      screenshotPath: '/tmp/opensafari-debug/b1/screenshot.png',
      axTreePath: '/tmp/opensafari-debug/b1/ax-tree.json',
      logsPath: '/tmp/opensafari-debug/b1/logs.txt',
      crashCount: 0,
      redactions: { applied: ['logs.bearer'], policy: 'default-v1' },
    });
    expect(JSON.stringify(payload.debugBundle)).not.toContain('Bearer [REDACTED]');
  });

  it('uses existing structured error style for snapshot failures', async () => {
    const { AppStateSnapshotError } = await import('../../src/tools/app-state-snapshot');
    collectAppSessionStateMock.mockRejectedValueOnce(
      new AppStateSnapshotError('No booted simulator found', ErrorCode.DEVICE_NOT_BOOTED),
    );

    const result = await callTool({});
    const payload = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      error: ErrorCode.DEVICE_NOT_BOOTED,
      message: 'No booted simulator found',
      recoverable: true,
    });
    expect(payload.suggestion).toBeTruthy();
  });

  it('redacts password-like visible text from classifier diagnostics', async () => {
    collectAppSessionStateMock.mockResolvedValueOnce(appState(['Apple ID', 'Password: hunter2']));

    const result = await callTool({});
    const payload = parseToolResult(result);
    const serialized = JSON.stringify(payload);

    expect(payload.classifier.phase).toBe('APPLE_ID_SIGN_IN_REQUIRED');
    expect(serialized).toContain('[REDACTED_SENSITIVE_UI_TEXT]');
    expect(serialized).not.toContain('hunter2');
  });
});
