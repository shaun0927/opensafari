import { MCPServer } from '../../src/mcp-server';
import { registerAppPermissionsTool, VALID_PERMISSIONS } from '../../src/tools/app-permissions';
import { registerAppDeeplinkTool } from '../../src/tools/app-deeplink';
import { registerAppPushNotificationTool } from '../../src/tools/app-push-notification';
import { buildAPNsPayload } from '../../src/tools/app-push-notification';
import { registerAppHandleAlertTool, buildAlertScript } from '../../src/tools/app-handle-alert';

// --- Mocks ---

// Mock SimctlExecutor
const mockExec = jest.fn().mockResolvedValue('');
jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockExec,
  })),
}));

// Mock session manager to return a device ID
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('MOCK-DEVICE-UUID'),
  }),
}));

// Mock child_process execFile for alert handling
const mockExecFile = jest.fn().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (...cbArgs: unknown[]) => void) => {
  if (cb) cb(null, '', '');
});
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock util.promisify to return our mock
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

// Mock fs/promises for push notification temp files
jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

describe('app_permissions tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppPermissionsTool(server);
  });

  beforeEach(() => {
    mockExec.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_permissions');
  });

  test('grants camera permission', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    const result = await handler('test', {
      action: 'grant',
      permission: 'camera',
      bundleId: 'com.example.app',
    });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.action).toBe('grant');
    expect(text.permission).toBe('camera');
    expect(text.bundleId).toBe('com.example.app');
    expect(text.success).toBe(true);
    expect(mockExec).toHaveBeenCalledWith([
      'privacy', 'MOCK-DEVICE-UUID', 'grant', 'camera', 'com.example.app',
    ]);
  });

  test('maps speech to speech-recognition service', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    await handler('test', {
      action: 'grant',
      permission: 'speech',
      bundleId: 'com.example.app',
    });
    expect(mockExec).toHaveBeenCalledWith([
      'privacy', 'MOCK-DEVICE-UUID', 'grant', 'speech-recognition', 'com.example.app',
    ]);
  });

  test('revokes location permission', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    const result = await handler('test', {
      action: 'revoke',
      permission: 'location',
      bundleId: 'com.example.app',
    });
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.action).toBe('revoke');
    expect(mockExec).toHaveBeenCalledWith([
      'privacy', 'MOCK-DEVICE-UUID', 'revoke', 'location', 'com.example.app',
    ]);
  });

  test('resets all permissions', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    await handler('test', {
      action: 'reset',
      permission: 'all',
      bundleId: 'com.example.app',
    });
    expect(mockExec).toHaveBeenCalledWith([
      'privacy', 'MOCK-DEVICE-UUID', 'reset', 'all', 'com.example.app',
    ]);
  });

  test('rejects invalid permission', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    const result = await handler('test', {
      action: 'grant',
      permission: 'bluetooth',
      bundleId: 'com.example.app',
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('invalid permission');
  });

  test('rejects invalid action', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    const result = await handler('test', {
      action: 'delete',
      permission: 'camera',
      bundleId: 'com.example.app',
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('invalid action');
  });

  test('uses explicit deviceId when provided', async () => {
    const handler = server.getToolHandler('app_permissions')!;
    await handler('test', {
      action: 'grant',
      permission: 'photos',
      bundleId: 'com.example.app',
      deviceId: 'CUSTOM-UUID',
    });
    expect(mockExec).toHaveBeenCalledWith([
      'privacy', 'CUSTOM-UUID', 'grant', 'photos', 'com.example.app',
    ]);
  });

  test('handles simctl exec failure', async () => {
    mockExec.mockRejectedValueOnce(new Error('simctl privacy failed'));
    const handler = server.getToolHandler('app_permissions')!;
    const result = await handler('test', {
      action: 'grant',
      permission: 'camera',
      bundleId: 'com.example.app',
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('simctl privacy failed');
  });

  test('VALID_PERMISSIONS includes expected entries', () => {
    expect(VALID_PERMISSIONS).toContain('camera');
    expect(VALID_PERMISSIONS).toContain('photos');
    expect(VALID_PERMISSIONS).toContain('microphone');
    expect(VALID_PERMISSIONS).toContain('location');
    expect(VALID_PERMISSIONS).toContain('speech');
    expect(VALID_PERMISSIONS).toContain('all');
    expect(VALID_PERMISSIONS).toContain('media-library');
  });
});

describe('app_deeplink tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppDeeplinkTool(server);
  });

  beforeEach(() => {
    mockExec.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_deeplink');
  });

  test('opens custom scheme URL', async () => {
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('test', { url: 'myapp://settings/profile' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.url).toBe('myapp://settings/profile');
    expect(text.deviceId).toBe('MOCK-DEVICE-UUID');
    expect(text.openedAt).toBeDefined();
    expect(mockExec).toHaveBeenCalledWith([
      'openurl', 'MOCK-DEVICE-UUID', 'myapp://settings/profile',
    ]);
  });

  test('opens universal link', async () => {
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('test', { url: 'https://example.com/app/page' });
    expect(result.isError).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith([
      'openurl', 'MOCK-DEVICE-UUID', 'https://example.com/app/page',
    ]);
  });

  test('rejects URL without scheme', async () => {
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('test', { url: 'example.com/page' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('must include a scheme');
  });

  test('rejects empty URL', async () => {
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('test', { url: '' });
    expect(result.isError).toBe(true);
  });

  test('uses explicit deviceId', async () => {
    const handler = server.getToolHandler('app_deeplink')!;
    await handler('test', { url: 'myapp://test', deviceId: 'CUSTOM-UUID' });
    expect(mockExec).toHaveBeenCalledWith([
      'openurl', 'CUSTOM-UUID', 'myapp://test',
    ]);
  });

  test('handles simctl exec failure', async () => {
    mockExec.mockRejectedValueOnce(new Error('openurl failed'));
    const handler = server.getToolHandler('app_deeplink')!;
    const result = await handler('test', { url: 'myapp://test' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('openurl failed');
  });
});

describe('app_push_notification tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppPushNotificationTool(server);
  });

  beforeEach(() => {
    mockExec.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_push_notification');
  });

  test('rejects empty bundleId', async () => {
    const handler = server.getToolHandler('app_push_notification')!;
    const result = await handler('test', { bundleId: '' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('bundleId is required');
  });

  describe('buildAPNsPayload', () => {
    test('builds default payload with title and body', () => {
      const payload = buildAPNsPayload({ title: 'Hello', body: 'World' });
      expect(payload.aps.alert).toEqual({ title: 'Hello', body: 'World' });
      expect(payload.aps.badge).toBeUndefined();
    });

    test('uses default title when not provided', () => {
      const payload = buildAPNsPayload({});
      expect(payload.aps.alert!.title).toBe('Test Notification');
      expect(payload.aps.alert!.body).toBe('');
    });

    test('includes badge when provided', () => {
      const payload = buildAPNsPayload({ title: 'Hi', body: 'Test', badge: 5 });
      expect(payload.aps.badge).toBe(5);
    });

    test('includes badge 0', () => {
      const payload = buildAPNsPayload({ badge: 0 });
      expect(payload.aps.badge).toBe(0);
    });

    test('uses custom payload when provided', () => {
      const custom = { aps: { alert: { title: 'Custom' }, sound: 'chime.aiff' } };
      const payload = buildAPNsPayload({ payload: custom, title: 'Ignored' });
      expect(payload).toEqual(custom);
    });
  });
});

describe('app_handle_alert tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppHandleAlertTool(server);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_handle_alert');
  });

  test('rejects invalid action', async () => {
    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('test', { action: 'close' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('invalid action');
  });

  describe('buildAlertScript', () => {
    test('accept script tries Allow, OK, Allow While Using App', () => {
      const script = buildAlertScript('accept');
      expect(script).toContain('click button "Allow"');
      expect(script).toContain('click button "OK"');
      expect(script).toContain('click button "Allow While Using App"');
    });

    test('dismiss script tries Don\'t Allow, Cancel', () => {
      const script = buildAlertScript('dismiss');
      expect(script).toContain("click button \"Don't Allow\"");
      expect(script).toContain('click button "Cancel"');
    });

    test('script activates Simulator', () => {
      const script = buildAlertScript('accept');
      expect(script).toContain('tell application "Simulator" to activate');
    });
  });
});
