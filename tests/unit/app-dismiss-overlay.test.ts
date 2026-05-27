import { MCPServer } from '../../src/mcp-server';
import { registerAppDismissOverlayTool } from '../../src/tools/app-dismiss-overlay';

const mockSendKey = jest.fn();
const mockTap = jest.fn();
const mockSwipe = jest.fn();
const mockQuery = jest.fn();
let mockActiveDeviceId: string | null = null;

jest.mock('../../src/tools/native-input-utils', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simhid' as const,
    headless: true,
    sendKey: mockSendKey,
    tap: mockTap,
    swipe: mockSwipe,
    typeText: jest.fn(),
    keypress: jest.fn(),
  })),
}));

jest.mock('../../src/native', () => ({
  getAccessibilityBridge: () => ({
    query: mockQuery,
  }),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => mockActiveDeviceId,
    getConnection: () => null,
  }),
}));

describe('app_dismiss_overlay tool', () => {
  let server: MCPServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveDeviceId = 'device-1';
    mockSendKey.mockResolvedValue(undefined);
    mockTap.mockResolvedValue(undefined);
    mockSwipe.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ matches: [] });
    server = new MCPServer();
    registerAppDismissOverlayTool(server);
  });

  function handler() {
    return server.getToolHandler('app_dismiss_overlay')!;
  }

  test('preserves fast no-verification mode', async () => {
    const result = await handler()('session', { mode: 'auto' });

    expect(result.isError).toBeUndefined();
    expect(mockSendKey).toHaveBeenCalledWith('device-1', 'Escape');
    expect(mockTap).toHaveBeenCalledWith('device-1', 24, 96);
    expect(mockSwipe).toHaveBeenCalledWith('device-1', 200, 240, 200, 720, 0.25);
    expect(mockQuery).not.toHaveBeenCalled();
    const body = JSON.parse(result.content![0].text!);
    expect(body).toMatchObject({
      dismissed: true,
      verified: null,
      verification: { requested: false },
      strategiesTried: ['escape', 'scrim_tap', 'swipe_down'],
    });
  });

  test('verifies waitForGone postcondition', async () => {
    mockQuery
      .mockResolvedValueOnce({ matches: [{ label: 'Menu' }] })
      .mockResolvedValueOnce({ matches: [] });

    const result = await handler()('session', {
      mode: 'dialog',
      waitForGone: { label: 'Menu', timeoutMs: 500, intervalMs: 1 },
    });

    expect(result.isError).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith(
      { identifier: undefined, label: 'Menu', text: undefined, role: undefined },
      { deviceId: 'device-1' },
    );
    const body = JSON.parse(result.content![0].text!);
    expect(body.dismissed).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.verification).toMatchObject({
      requested: true,
      kind: 'gone',
      verified: true,
      finalMatchCount: 0,
      strict: true,
    });
  });

  test('strict verification failure returns isError', async () => {
    mockQuery.mockResolvedValue({ matches: [{ label: 'Still here' }] });

    const result = await handler()('session', {
      mode: 'bottom_sheet',
      waitForGone: { label: 'Still here', timeoutMs: 0 },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content![0].text!);
    expect(body.dismissed).toBe(false);
    expect(body.verified).toBe(false);
    expect(body.verification).toMatchObject({
      requested: true,
      kind: 'gone',
      verified: false,
      strict: true,
      finalMatchCount: 1,
    });
  });

  test('non-strict verification failure is diagnostic only', async () => {
    mockQuery.mockResolvedValue({ matches: [] });

    const result = await handler()('session', {
      mode: 'drawer',
      waitForVisible: { label: 'Home', timeoutMs: 0 },
      verifyStrict: false,
    });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content![0].text!);
    expect(body.dismissed).toBe(false);
    expect(body.verified).toBe(false);
    expect(body.verification).toMatchObject({
      requested: true,
      kind: 'visible',
      verified: false,
      strict: false,
    });
  });

  test('rejects ambiguous verification inputs', async () => {
    const result = await handler()('session', {
      waitForGone: { label: 'A' },
      waitForVisible: { label: 'B' },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content![0].text!);
    expect(body.error).toBe('INVALID_VERIFICATION');
  });
});
