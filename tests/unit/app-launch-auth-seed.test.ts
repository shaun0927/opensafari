/**
 * Unit tests for PR4 — `app_launch` auth pre-seed hook.
 *
 * Verifies the new `authProfile` argument hands off to
 * NativeAuthManager.restore() before manager.launchApp() runs, and that
 * restore failures degrade gracefully to a warning instead of aborting
 * the launch.
 */

const mockRestore = jest.fn();
const mockLaunchApp = jest.fn();
const mockListBooted = jest.fn();

jest.mock('../../src/auth/native-manager', () => ({
  NativeAuthManager: jest.fn().mockImplementation(() => ({
    restore: mockRestore,
  })),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    launchApp: mockLaunchApp,
    listBooted: mockListBooted,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'DEV-1',
  }),
}));

import { registerAppLaunchTool } from '../../src/tools/app-launch';

type Handler = (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_descriptor: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as Parameters<typeof registerAppLaunchTool>[0];
  registerAppLaunchTool(server);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('app_launch with authProfile', () => {
  beforeEach(() => {
    mockRestore.mockReset();
    mockLaunchApp.mockReset();
    mockListBooted.mockReset();
    mockListBooted.mockResolvedValue([{ udid: 'DEV-1' }]);
    mockLaunchApp.mockResolvedValue({ launched: true, pid: 12345 });
  });

  it('restores the native auth profile before launchApp and reports keychain status', async () => {
    mockRestore.mockResolvedValue({
      profile: 'logged-in',
      bundleId: 'com.example.app',
      deviceUdid: 'DEV-1',
      keychainArchive: '/tmp/keychains.tar',
    });

    const handler = captureHandler();
    const result = await handler('s', { bundleId: 'com.example.app', authProfile: 'logged-in' });
    const body = JSON.parse(result.content[0].text);

    // restore was called BEFORE launchApp.
    const restoreOrder = mockRestore.mock.invocationCallOrder[0];
    const launchOrder = mockLaunchApp.mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(launchOrder);

    expect(mockRestore).toHaveBeenCalledWith('DEV-1', 'com.example.app', 'logged-in');
    expect(body.launched).toBe(true);
    expect(body.authRestored).toEqual({ profile: 'logged-in', keychain: true });
  });

  it('surfaces restore failure as a warning but still launches', async () => {
    mockRestore.mockRejectedValue(new Error('container.tar missing'));

    const handler = captureHandler();
    const result = await handler('s', { bundleId: 'com.example.app', authProfile: 'broken' });
    const body = JSON.parse(result.content[0].text);

    expect(mockLaunchApp).toHaveBeenCalled();
    expect(body.launched).toBe(true);
    expect(body.authRestored).toMatchObject({
      profile: 'broken',
      keychain: false,
      warning: expect.stringContaining('container.tar missing'),
    });
  });

  it('skips restore entirely when authProfile is omitted', async () => {
    const handler = captureHandler();
    const result = await handler('s', { bundleId: 'com.example.app' });
    const body = JSON.parse(result.content[0].text);

    expect(mockRestore).not.toHaveBeenCalled();
    expect(body.authRestored).toBe(false);
  });
});
