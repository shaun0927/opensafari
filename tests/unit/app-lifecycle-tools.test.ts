import { MCPServer } from '../../src/mcp-server';
import { registerAppLaunchTool } from '../../src/tools/app-launch';
import { registerAppTerminateTool } from '../../src/tools/app-terminate';
import { registerAppListAppsTool } from '../../src/tools/app-list-apps';
import { registerAppOpenUrlTool } from '../../src/tools/app-open-url';
import { getSessionManager } from '../../src/session-manager';
import * as simctlModule from '../../src/simulator/simctl';

// Mock SimctlExecutor to avoid requiring actual simulator
jest.mock('../../src/simulator/simctl', () => {
  const execMock = jest.fn();
  return {
    SimctlExecutor: jest.fn().mockImplementation(() => ({
      exec: execMock,
    })),
    __execMock: execMock,
  };
});

// Get the mocked exec function
function getExecMock(): jest.Mock {
  return (simctlModule as any).__execMock;
}

describe('Native App Lifecycle Tools', () => {
  let server: MCPServer;
  let execMock: jest.Mock;

  beforeAll(() => {
    server = new MCPServer();
    registerAppLaunchTool(server);
    registerAppTerminateTool(server);
    registerAppListAppsTool(server);
    registerAppOpenUrlTool(server);
  });

  beforeEach(() => {
    execMock = getExecMock();
    execMock.mockReset();

    // Set up an active device in the session manager
    const sm = getSessionManager();
    if (!sm.getSimulator('TEST-DEVICE-UUID')) {
      sm.addSimulator('TEST-DEVICE-UUID', {
        deviceId: 'TEST-DEVICE-UUID',
        deviceType: 'iPhone 16',
        state: 'booted',
        viewport: { width: 393, height: 852 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
    }
  });

  afterEach(() => {
    execMock.mockReset();
  });

  // ─── app_launch ─────────────────────────────────────────────────────

  describe('app_launch', () => {
    test('is registered with correct name', () => {
      expect(server.getRegisteredTools()).toContain('app_launch');
    });

    test('launches an app and returns PID', async () => {
      execMock.mockResolvedValueOnce('com.apple.mobilesafari: 12345\n');

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', {
        bundleId: 'com.apple.mobilesafari',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.bundleId).toBe('com.apple.mobilesafari');
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
      expect(text.pid).toBe(12345);
      expect(text.launchedAt).toBeDefined();

      expect(execMock).toHaveBeenCalledWith([
        'launch',
        'TEST-DEVICE-UUID',
        'com.apple.mobilesafari',
      ]);
    });

    test('uses active device when deviceId is omitted', async () => {
      execMock.mockResolvedValueOnce('com.example.app: 999\n');

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', { bundleId: 'com.example.app' });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
    });

    test('passes launch arguments', async () => {
      execMock.mockResolvedValueOnce('com.example.app: 100\n');

      const handler = server.getToolHandler('app_launch')!;
      await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
        args: ['-debug', '--verbose'],
      });

      expect(execMock).toHaveBeenCalledWith([
        'launch',
        'TEST-DEVICE-UUID',
        'com.example.app',
        '-debug',
        '--verbose',
      ]);
    });

    test('terminates existing instance when terminateFirst is true', async () => {
      execMock
        .mockResolvedValueOnce('') // terminate call
        .mockResolvedValueOnce('com.example.app: 200\n'); // launch call

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
        terminateFirst: true,
      });

      expect(result.isError).toBeUndefined();
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(execMock.mock.calls[0]).toEqual([
        ['terminate', 'TEST-DEVICE-UUID', 'com.example.app'],
      ]);
      expect(execMock.mock.calls[1]).toEqual([
        ['launch', 'TEST-DEVICE-UUID', 'com.example.app'],
      ]);
    });

    test('ignores terminate errors when terminateFirst is true', async () => {
      execMock
        .mockRejectedValueOnce(new Error('app not running'))
        .mockResolvedValueOnce('com.example.app: 300\n');

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
        terminateFirst: true,
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.pid).toBe(300);
    });

    test('returns error when launch fails', async () => {
      execMock.mockRejectedValueOnce(new Error('Unable to launch com.invalid.app'));

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', {
        bundleId: 'com.invalid.app',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('Unable to launch');
    });

    test('handles missing PID in output gracefully', async () => {
      execMock.mockResolvedValueOnce('launched\n');

      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.pid).toBeNull();
    });
  });

  // ─── app_terminate ──────────────────────────────────────────────────

  describe('app_terminate', () => {
    test('is registered with correct name', () => {
      expect(server.getRegisteredTools()).toContain('app_terminate');
    });

    test('terminates a running app', async () => {
      execMock.mockResolvedValueOnce('');

      const handler = server.getToolHandler('app_terminate')!;
      const result = await handler('test', {
        bundleId: 'com.apple.mobilesafari',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.bundleId).toBe('com.apple.mobilesafari');
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
      expect(text.terminatedAt).toBeDefined();

      expect(execMock).toHaveBeenCalledWith([
        'terminate',
        'TEST-DEVICE-UUID',
        'com.apple.mobilesafari',
      ]);
    });

    test('uses active device when deviceId is omitted', async () => {
      execMock.mockResolvedValueOnce('');

      const handler = server.getToolHandler('app_terminate')!;
      const result = await handler('test', { bundleId: 'com.example.app' });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
    });

    test('handles app not running gracefully', async () => {
      execMock.mockRejectedValueOnce(new Error('app not running'));

      const handler = server.getToolHandler('app_terminate')!;
      const result = await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
      });

      // Should succeed (not an error) because we handle the "not running" case
      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.terminatedAt).toBeDefined();
    });

    test('returns error for unexpected failures', async () => {
      execMock.mockRejectedValueOnce(new Error('device not booted'));

      const handler = server.getToolHandler('app_terminate')!;
      const result = await handler('test', {
        bundleId: 'com.example.app',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('device not booted');
    });
  });

  // ─── app_list_apps ──────────────────────────────────────────────────

  describe('app_list_apps', () => {
    test('is registered with correct name', () => {
      expect(server.getRegisteredTools()).toContain('app_list_apps');
    });

    test('parses plist output and returns app list', async () => {
      const plistOutput = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.apple.mobilesafari</string>
    <key>CFBundleDisplayName</key>
    <string>Safari</string>
    <key>CFBundleShortVersionString</key>
    <string>17.0</string>
    <key>Path</key>
    <string>/Applications/MobileSafari.app</string>
  </dict>
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.apple.Preferences</string>
    <key>CFBundleName</key>
    <string>Settings</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>BundlePath</key>
    <string>/Applications/Preferences.app</string>
  </dict>
</array>
</plist>`;

      execMock.mockResolvedValueOnce(plistOutput);

      const handler = server.getToolHandler('app_list_apps')!;
      const result = await handler('test', { deviceId: 'TEST-DEVICE-UUID' });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
      expect(text.count).toBe(2);
      expect(text.apps).toHaveLength(2);

      expect(text.apps[0].bundleId).toBe('com.apple.mobilesafari');
      expect(text.apps[0].name).toBe('Safari');
      expect(text.apps[0].version).toBe('17.0');
      expect(text.apps[0].path).toBe('/Applications/MobileSafari.app');

      expect(text.apps[1].bundleId).toBe('com.apple.Preferences');
      expect(text.apps[1].name).toBe('Settings');
      expect(text.apps[1].version).toBe('1.0');
      expect(text.apps[1].path).toBe('/Applications/Preferences.app');
    });

    test('uses active device when deviceId is omitted', async () => {
      execMock.mockResolvedValueOnce('<plist version="1.0"><array></array></plist>');

      const handler = server.getToolHandler('app_list_apps')!;
      const result = await handler('test', {});

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');

      expect(execMock).toHaveBeenCalledWith(['listapps', 'TEST-DEVICE-UUID']);
    });

    test('handles empty app list', async () => {
      execMock.mockResolvedValueOnce('<plist version="1.0"><array></array></plist>');

      const handler = server.getToolHandler('app_list_apps')!;
      const result = await handler('test', { deviceId: 'TEST-DEVICE-UUID' });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.count).toBe(0);
      expect(text.apps).toHaveLength(0);
    });

    test('returns error when simctl fails', async () => {
      execMock.mockRejectedValueOnce(new Error('device not booted'));

      const handler = server.getToolHandler('app_list_apps')!;
      const result = await handler('test', { deviceId: 'INVALID-UUID' });

      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('device not booted');
    });
  });

  // ─── app_open_url ───────────────────────────────────────────────────

  describe('app_open_url', () => {
    test('is registered with correct name', () => {
      expect(server.getRegisteredTools()).toContain('app_open_url');
    });

    test('opens an https URL', async () => {
      execMock.mockResolvedValueOnce('');

      const handler = server.getToolHandler('app_open_url')!;
      const result = await handler('test', {
        url: 'https://example.com',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.url).toBe('https://example.com');
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
      expect(text.openedAt).toBeDefined();

      expect(execMock).toHaveBeenCalledWith([
        'openurl',
        'TEST-DEVICE-UUID',
        'https://example.com',
      ]);
    });

    test('opens a deep link', async () => {
      execMock.mockResolvedValueOnce('');

      const handler = server.getToolHandler('app_open_url')!;
      const result = await handler('test', {
        url: 'myapp://settings/profile',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.url).toBe('myapp://settings/profile');

      expect(execMock).toHaveBeenCalledWith([
        'openurl',
        'TEST-DEVICE-UUID',
        'myapp://settings/profile',
      ]);
    });

    test('uses active device when deviceId is omitted', async () => {
      execMock.mockResolvedValueOnce('');

      const handler = server.getToolHandler('app_open_url')!;
      const result = await handler('test', { url: 'https://example.com' });

      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.deviceId).toBe('TEST-DEVICE-UUID');
    });

    test('returns error when openurl fails', async () => {
      execMock.mockRejectedValueOnce(new Error('device not booted'));

      const handler = server.getToolHandler('app_open_url')!;
      const result = await handler('test', {
        url: 'https://example.com',
        deviceId: 'TEST-DEVICE-UUID',
      });

      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('device not booted');
    });
  });

  // ─── No device scenarios ────────────────────────────────────────────

  describe('error handling — no active device', () => {
    beforeEach(() => {
      // Shut down the session manager so there's no active device
      const sm = getSessionManager();
      sm.removeSimulator('TEST-DEVICE-UUID');
    });

    afterEach(() => {
      // Restore for other tests
      const sm = getSessionManager();
      if (!sm.getSimulator('TEST-DEVICE-UUID')) {
        sm.addSimulator('TEST-DEVICE-UUID', {
          deviceId: 'TEST-DEVICE-UUID',
          deviceType: 'iPhone 16',
          state: 'booted',
          viewport: { width: 393, height: 852 },
          bootedAt: Date.now(),
          lastActivity: Date.now(),
        });
      }
    });

    test('app_launch returns error when no device available', async () => {
      const handler = server.getToolHandler('app_launch')!;
      const result = await handler('test', { bundleId: 'com.example.app' });
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('No device specified');
    });

    test('app_terminate returns error when no device available', async () => {
      const handler = server.getToolHandler('app_terminate')!;
      const result = await handler('test', { bundleId: 'com.example.app' });
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('No device specified');
    });

    test('app_list_apps returns error when no device available', async () => {
      const handler = server.getToolHandler('app_list_apps')!;
      const result = await handler('test', {});
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('No device specified');
    });

    test('app_open_url returns error when no device available', async () => {
      const handler = server.getToolHandler('app_open_url')!;
      const result = await handler('test', { url: 'https://example.com' });
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as any)[0].text);
      expect(text.error).toContain('No device specified');
    });
  });
});
