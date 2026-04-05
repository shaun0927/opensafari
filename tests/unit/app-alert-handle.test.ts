import { MCPServer } from '../../src/mcp-server';
import { registerAppAlertHandleTool } from '../../src/tools/app-alert-handle';

// ── Mocks ──

const mockSendKey = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
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
    mockSendKey.mockResolvedValue(undefined);

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

  test('accepts an alert via sendKey Return', async () => {
    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('test', { action: 'accept' });
    expect(result.isError).toBeUndefined();
    const text = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(text.handled).toBe(true);
    expect(text.action).toBe('accept');
    expect(text.method).toBe('input_backend');
    expect(text.deviceId).toBe('TEST-UDID-1234');
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
});
