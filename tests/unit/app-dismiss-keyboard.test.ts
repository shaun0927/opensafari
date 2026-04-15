/**
 * app_dismiss_keyboard tool — Unit Tests
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppDismissKeyboardTool } from '../../src/tools/app-dismiss-keyboard';

// ── Mocks ──

const mockSendKey = jest.fn();
const mockTap = jest.fn();
const mockListBooted = jest.fn();

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    sendKey: mockSendKey,
    tap: mockTap,
    swipe: jest.fn(),
    typeText: jest.fn(),
    keypress: jest.fn(),
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: mockListBooted,
  })),
}));

let mockActiveDeviceId: string | null = null;

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => mockActiveDeviceId,
  }),
}));

function setActiveDeviceId(id: string | null): void {
  mockActiveDeviceId = id;
}

// ── Tests ──

describe('app_dismiss_keyboard tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppDismissKeyboardTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setActiveDeviceId(null);
    mockListBooted.mockResolvedValue([]);
    mockSendKey.mockResolvedValue(undefined);
    mockTap.mockResolvedValue(undefined);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_dismiss_keyboard');
  });

  test('dismisses keyboard via sendKey Escape (primary method)', async () => {
    setActiveDeviceId('device-123');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockSendKey).toHaveBeenCalledWith('device-123', 'Escape');
    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.dismissed).toBe(true);
    expect(body.deviceId).toBe('device-123');
    expect(body.method).toBe('sendkey');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'device-123' });
  });

  test('falls back to tap when sendKey fails', async () => {
    setActiveDeviceId('device-456');
    mockSendKey.mockRejectedValueOnce(new Error('sendkey not supported'));

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockSendKey).toHaveBeenCalledWith('device-456', 'Escape');
    expect(mockTap).toHaveBeenCalledWith('device-456', 195, 50);
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.dismissed).toBe(true);
    expect(body.method).toBe('tap_fallback');
  });

  test('returns error when no device is booted', async () => {
    setActiveDeviceId(null);
    mockListBooted.mockResolvedValue([]);

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.code).toBe('DEVICE_NOT_BOOTED');
  });

  test('uses explicit deviceId when provided', async () => {
    setActiveDeviceId('active-device');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', { deviceId: 'explicit-device' });

    expect(mockSendKey).toHaveBeenCalledWith('explicit-device', 'Escape');
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.deviceId).toBe('explicit-device');
  });

  test('returns error when both methods fail', async () => {
    setActiveDeviceId('device-789');
    mockSendKey.mockRejectedValueOnce(new Error('sendkey failed'));
    mockTap.mockRejectedValueOnce(new Error('tap failed'));

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.code).toBe('KEYBOARD_DISMISS_FAILED');
    expect(body.deviceId).toBe('device-789');
  });

  test('falls back to first booted device when no active device', async () => {
    setActiveDeviceId(null);
    mockListBooted.mockResolvedValue([{ udid: 'booted-device-1' }]);

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockSendKey).toHaveBeenCalledWith('booted-device-1', 'Escape');
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.deviceId).toBe('booted-device-1');
  });
});
