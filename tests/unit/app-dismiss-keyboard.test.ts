/**
 * app_dismiss_keyboard tool — Unit Tests
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppDismissKeyboardTool } from '../../src/tools/app-dismiss-keyboard';

// ── Mocks ──

const mockExec = jest.fn();
const mockListBooted = jest.fn();

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    getSimctl: () => ({ exec: mockExec }),
    listBooted: mockListBooted,
  })),
}));

let mockActiveDeviceId: string | null = null;

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getActiveDeviceId: () => mockActiveDeviceId,
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
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_dismiss_keyboard');
  });

  test('dismisses keyboard via sendkey Escape (primary method)', async () => {
    setActiveDeviceId('device-123');
    mockExec.mockResolvedValueOnce('');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'device-123', 'sendkey', 'Escape'],
      { timeout: 5000 },
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.dismissed).toBe(true);
    expect(body.deviceId).toBe('device-123');
    expect(body.method).toBe('sendkey');
  });

  test('falls back to tap when sendkey fails', async () => {
    setActiveDeviceId('device-456');
    mockExec
      .mockRejectedValueOnce(new Error('sendkey not supported'))
      .mockResolvedValueOnce('');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      ['io', 'device-456', 'sendkey', 'Escape'],
      { timeout: 5000 },
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      ['io', 'device-456', 'input', 'tap', '195', '50'],
      { timeout: 5000 },
    );
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
    mockExec.mockResolvedValueOnce('');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', { deviceId: 'explicit-device' });

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'explicit-device', 'sendkey', 'Escape'],
      { timeout: 5000 },
    );
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.deviceId).toBe('explicit-device');
  });

  test('returns error when both methods fail', async () => {
    setActiveDeviceId('device-789');
    mockExec
      .mockRejectedValueOnce(new Error('sendkey failed'))
      .mockRejectedValueOnce(new Error('tap failed'));

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
    mockExec.mockResolvedValueOnce('');

    const handler = server.getToolHandler('app_dismiss_keyboard')!;
    const result = await handler('test-session', {});

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'booted-device-1', 'sendkey', 'Escape'],
      { timeout: 5000 },
    );
    const body = JSON.parse((result.content as any)[0].text);
    expect(body.deviceId).toBe('booted-device-1');
  });
});
