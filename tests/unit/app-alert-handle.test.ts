import { MCPServer } from '../../src/mcp-server';
import { registerAppAlertHandleTool } from '../../src/tools/app-alert-handle';

// ── Mocks ──

jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
    cb(new Error('osascript not available in test'), '', '');
  }),
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
    getActiveDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
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

// ── Tests ──

describe('app_alert_handle tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppAlertHandleTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-setup default mock returns after clearAllMocks
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(''),
      }),
    }));
    getSessionManager.mockReturnValue({
      getActiveDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
    });
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_alert_handle');
  });

  test('accepts an alert via sendkey Return', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });
    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.action).toBe('accept');
    expect(text.method).toBe('sendkey');
    expect(text.deviceId).toBe('TEST-UDID-1234');
  });

  test('dismisses an alert via sendkey Escape', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'dismiss' });
    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.action).toBe('dismiss');
    expect(text.method).toBe('sendkey');
  });

  test('sends correct key for accept (Return)', async () => {
    const mockExec = jest.fn().mockResolvedValue('');
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({ exec: mockExec }),
    }));

    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'accept' });

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'TEST-UDID-1234', 'sendkey', 'Return'],
      { timeout: 10000 },
    );
  });

  test('sends correct key for dismiss (Escape)', async () => {
    const mockExec = jest.fn().mockResolvedValue('');
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({ exec: mockExec }),
    }));

    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'dismiss' });

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'TEST-UDID-1234', 'sendkey', 'Escape'],
      { timeout: 10000 },
    );
  });

  test('rejects invalid action', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'close' });
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('INVALID_ACTION');
    expect(text.message).toContain('"close"');
  });

  test('returns error when no device is booted', async () => {
    getSessionManager.mockReturnValue({
      getActiveDeviceId: jest.fn().mockReturnValue(null),
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
    const mockExec = jest.fn().mockResolvedValue('');
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({ exec: mockExec }),
    }));

    const handler = server.getToolHandler('app_alert_handle')!;
    await handler('test', { action: 'accept', deviceId: 'CUSTOM-UDID' });

    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'CUSTOM-UDID', 'sendkey', 'Return'],
      { timeout: 10000 },
    );
  });

  test('falls back to AppleScript when sendkey fails, then reports error if both fail', async () => {
    const mockExec = jest.fn().mockRejectedValue(new Error('sendkey not supported'));
    SimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
      getSimctl: jest.fn().mockReturnValue({ exec: mockExec }),
    }));

    // AppleScript will also fail in test environment (no Simulator.app)
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });

    // Both methods fail in test — should get ALERT_HANDLE_FAILED
    expect(result.isError).toBe(true);
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.error).toBe('ALERT_HANDLE_FAILED');
    expect(text.message).toContain('Failed to accept alert');
  });
});
