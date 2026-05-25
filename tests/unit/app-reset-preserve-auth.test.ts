/**
 * Unit tests for PR9 — `app_reset` snapshotAuthProfile option.
 *
 * Verifies the snapshot happens BEFORE the reset (so the uninstall doesn't
 * take the data container down with it) and that snapshot failures degrade
 * to a warning without blocking the reset.
 */

const mockSave = jest.fn();
const mockResetApp = jest.fn();
const mockListBooted = jest.fn();

jest.mock('../../src/auth/native-manager', () => ({
  NativeAuthManager: jest.fn().mockImplementation(() => ({
    save: mockSave,
  })),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: mockListBooted,
    resetApp: mockResetApp,
  })),
  getDefaultSimulatorManager: jest.fn(() => ({
    listBooted: mockListBooted,
    resetApp: mockResetApp,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'DEV-1',
  }),
}));

import { registerAppResetTool } from '../../src/tools/app-reset';

type Handler = (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_d: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as Parameters<typeof registerAppResetTool>[0];
  registerAppResetTool(server);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('app_reset snapshotAuthProfile', () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockResetApp.mockReset();
    mockListBooted.mockReset();
    mockListBooted.mockResolvedValue([{ udid: 'DEV-1' }]);
    mockResetApp.mockResolvedValue({ reset: true, bundleId: 'com.example.app', deviceId: 'DEV-1', steps: ['terminated', 'privacy_reset', 'uninstalled'] });
  });

  it('captures the native auth snapshot BEFORE resetApp', async () => {
    mockSave.mockResolvedValue({
      profile: 'pre-reset',
      bundleId: 'com.example.app',
      deviceUdid: 'DEV-1',
      keychainArchive: '/tmp/keychains.tar',
    });

    const handler = captureHandler();
    const result = await handler('s', {
      bundleId: 'com.example.app',
      snapshotAuthProfile: 'pre-reset',
      includeKeychain: true,
    });
    const body = JSON.parse(result.content[0].text);

    const saveOrder = mockSave.mock.invocationCallOrder[0];
    const resetOrder = mockResetApp.mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(resetOrder);

    expect(mockSave).toHaveBeenCalledWith('DEV-1', 'com.example.app', 'pre-reset', { includeKeychain: true });
    expect(body.authSnapshot).toEqual({ profile: 'pre-reset', keychain: true });
  });

  it('surfaces snapshot failure as a warning but still resets', async () => {
    mockSave.mockRejectedValue(new Error('container missing'));

    const handler = captureHandler();
    const result = await handler('s', {
      bundleId: 'com.example.app',
      snapshotAuthProfile: 'broken',
    });
    const body = JSON.parse(result.content[0].text);

    expect(mockResetApp).toHaveBeenCalled();
    expect(body.reset).toBe(true);
    expect(body.authSnapshot).toMatchObject({
      profile: 'broken',
      keychain: false,
      warning: expect.stringContaining('container missing'),
    });
  });

  it('skips snapshot when snapshotAuthProfile is omitted', async () => {
    const handler = captureHandler();
    const result = await handler('s', { bundleId: 'com.example.app' });
    const body = JSON.parse(result.content[0].text);

    expect(mockSave).not.toHaveBeenCalled();
    expect(body.authSnapshot).toBe(false);
  });
});
