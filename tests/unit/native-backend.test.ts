import { SimctlNativeBackend } from '../../src/native/simctl-backend';
import { NotImplementedError } from '../../src/native/backend';
import type { SimctlExecutor } from '../../src/simulator/simctl';

// ── Mock SimctlExecutor ──────────────────────────────────────────

function createMockSimctl(responses: Record<string, string | Error> = {}): SimctlExecutor & { calls: string[][] } {
  const calls: string[][] = [];

  const mock = {
    calls,
    async exec(args: string[], _options?: { timeout?: number }): Promise<string> {
      calls.push(args);
      const key = args[0];
      const response = responses[key];
      if (response instanceof Error) {
        throw response;
      }
      return response ?? '';
    },
    async execJson<T>(args: string[]): Promise<T> {
      calls.push(args);
      const key = args[0];
      const response = responses[key];
      if (response instanceof Error) {
        throw response;
      }
      return JSON.parse(response ?? '{}') as T;
    },
  };

  return mock as unknown as SimctlExecutor & { calls: string[][] };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SimctlNativeBackend', () => {
  describe('launch', () => {
    it('should call simctl launch with bundle ID and default device', async () => {
      const simctl = createMockSimctl({
        launch: 'com.example.app: 12345\n',
      });
      const backend = new SimctlNativeBackend(simctl);

      const result = await backend.launch('com.example.app');

      expect(simctl.calls[0]).toEqual(['launch', 'booted', 'com.example.app']);
      expect(result.bundleId).toBe('com.example.app');
      expect(result.pid).toBe(12345);
      expect(result.deviceId).toBe('booted');
    });

    it('should use a custom device ID when provided', async () => {
      const simctl = createMockSimctl({
        launch: 'com.example.app: 999\n',
      });
      const backend = new SimctlNativeBackend(simctl);

      const result = await backend.launch('com.example.app', {
        deviceId: 'AAAA-BBBB',
      });

      expect(simctl.calls[0][1]).toBe('AAAA-BBBB');
      expect(result.deviceId).toBe('AAAA-BBBB');
    });

    it('should pass extra arguments to simctl', async () => {
      const simctl = createMockSimctl({ launch: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.launch('com.example.app', {
        arguments: ['--reset-state', '--verbose'],
      });

      expect(simctl.calls[0]).toEqual([
        'launch', 'booted', 'com.example.app',
        '--reset-state', '--verbose',
      ]);
    });

    it('should pass environment variables with SIMCTL_CHILD_ prefix', async () => {
      const simctl = createMockSimctl({ launch: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.launch('com.example.app', {
        environment: { DEBUG: '1' },
      });

      expect(simctl.calls[0]).toContain('SIMCTL_CHILD_DEBUG=1');
    });

    it('should propagate simctl errors', async () => {
      const simctl = createMockSimctl({
        launch: new Error('simctl launch failed: No such bundle ID'),
      });
      const backend = new SimctlNativeBackend(simctl);

      await expect(backend.launch('com.invalid.bundle')).rejects.toThrow(
        'No such bundle ID',
      );
    });
  });

  describe('terminate', () => {
    it('should call simctl terminate with correct args', async () => {
      const simctl = createMockSimctl({ terminate: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.terminate('com.example.app');

      expect(simctl.calls[0]).toEqual(['terminate', 'booted', 'com.example.app']);
    });

    it('should use custom device ID', async () => {
      const simctl = createMockSimctl({ terminate: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.terminate('com.example.app', 'CUSTOM-DEVICE');

      expect(simctl.calls[0]).toEqual(['terminate', 'CUSTOM-DEVICE', 'com.example.app']);
    });
  });

  describe('listApps', () => {
    it('should parse JSON app listing', async () => {
      const appsJson = JSON.stringify([
        {
          CFBundleIdentifier: 'com.apple.mobilesafari',
          CFBundleDisplayName: 'Safari',
          CFBundleShortVersionString: '17.0',
          Path: '/Applications/MobileSafari.app',
        },
        {
          CFBundleIdentifier: 'com.example.app',
          CFBundleName: 'MyApp',
        },
      ]);
      const simctl = createMockSimctl({ listapps: appsJson });
      const backend = new SimctlNativeBackend(simctl);

      const apps = await backend.listApps();

      expect(apps).toHaveLength(2);
      expect(apps[0]).toEqual({
        bundleId: 'com.apple.mobilesafari',
        displayName: 'Safari',
        version: '17.0',
        bundlePath: '/Applications/MobileSafari.app',
      });
      expect(apps[1]).toEqual({
        bundleId: 'com.example.app',
        displayName: 'MyApp',
        version: undefined,
        bundlePath: undefined,
      });
    });

    it('should return empty array on unparseable output', async () => {
      const simctl = createMockSimctl({ listapps: 'not valid json' });
      const backend = new SimctlNativeBackend(simctl);

      const apps = await backend.listApps();

      expect(apps).toEqual([]);
    });
  });

  describe('setPermission', () => {
    it('should map grant correctly', async () => {
      const simctl = createMockSimctl({ privacy: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.setPermission('camera', 'grant', 'com.example.app');

      expect(simctl.calls[0]).toEqual([
        'privacy', 'booted', 'grant', 'camera', 'com.example.app',
      ]);
    });

    it('should map revoke correctly', async () => {
      const simctl = createMockSimctl({ privacy: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.setPermission('location', 'revoke', 'com.example.app');

      expect(simctl.calls[0]).toEqual([
        'privacy', 'booted', 'revoke', 'location', 'com.example.app',
      ]);
    });

    it('should map reset correctly', async () => {
      const simctl = createMockSimctl({ privacy: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.setPermission('photos', 'reset', 'com.example.app');

      expect(simctl.calls[0]).toEqual([
        'privacy', 'booted', 'reset', 'photos', 'com.example.app',
      ]);
    });

    it('should use custom device ID', async () => {
      const simctl = createMockSimctl({ privacy: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.setPermission('microphone', 'grant', 'com.example.app', 'DEV-123');

      expect(simctl.calls[0][1]).toBe('DEV-123');
    });
  });

  describe('openUrl', () => {
    it('should call simctl openurl', async () => {
      const simctl = createMockSimctl({ openurl: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.openUrl('myapp://deep/link');

      expect(simctl.calls[0]).toEqual(['openurl', 'booted', 'myapp://deep/link']);
    });
  });

  describe('sendPushNotification', () => {
    it('should call simctl push with a temp payload file', async () => {
      const simctl = createMockSimctl({ push: '' });
      const backend = new SimctlNativeBackend(simctl);

      await backend.sendPushNotification('com.example.app', {
        aps: { alert: { title: 'Test', body: 'Hello' } },
      });

      expect(simctl.calls[0][0]).toBe('push');
      expect(simctl.calls[0][1]).toBe('booted');
      expect(simctl.calls[0][2]).toBe('com.example.app');
      // 4th arg is the temp file path, just check it exists
      expect(simctl.calls[0][3]).toMatch(/payload\.json$/);
    });
  });

  describe('captureScreenshot', () => {
    it('should call simctl io screenshot', async () => {
      // Since captureScreenshot reads a file from disk, we need to handle the
      // file system interaction. We test that the correct simctl args are passed.
      const simctl = createMockSimctl({ io: '' });
      const backend = new SimctlNativeBackend(simctl);

      // This will fail because the mock does not create the file,
      // but we can verify the simctl call was correct
      await expect(backend.captureScreenshot()).rejects.toThrow();
      expect(simctl.calls[0][0]).toBe('io');
      expect(simctl.calls[0][1]).toBe('booted');
      expect(simctl.calls[0][2]).toBe('screenshot');
    });
  });

  describe('getLogs', () => {
    it('should call simctl spawn with log show', async () => {
      const logOutput = JSON.stringify([
        { timestamp: '2026-04-05T10:00:00Z', messageType: 'info', process: 'MyApp', eventMessage: 'Started' },
      ]);
      const simctl = createMockSimctl({ spawn: logOutput });
      const backend = new SimctlNativeBackend(simctl);

      const logs = await backend.getLogs({ bundleId: 'com.example.app' });

      expect(simctl.calls[0][0]).toBe('spawn');
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Started');
    });

    it('should limit number of returned lines', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-04-05T10:00:0${i}Z`,
        messageType: 'info',
        process: 'App',
        eventMessage: `Log line ${i}`,
      }));
      const simctl = createMockSimctl({ spawn: JSON.stringify(entries) });
      const backend = new SimctlNativeBackend(simctl);

      const logs = await backend.getLogs({ lines: 3 });

      expect(logs).toHaveLength(3);
      // Should return the last 3 entries
      expect(logs[0].message).toBe('Log line 7');
    });

    it('should handle non-JSON log output gracefully', async () => {
      const simctl = createMockSimctl({ spawn: 'plain text log output' });
      const backend = new SimctlNativeBackend(simctl);

      const logs = await backend.getLogs();

      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('plain text log output');
    });
  });

  describe('v1.5 stubs (NotImplementedError)', () => {
    let backend: SimctlNativeBackend;

    beforeAll(() => {
      backend = new SimctlNativeBackend(createMockSimctl());
    });

    it('getAccessibilityTree should throw NotImplementedError', async () => {
      await expect(backend.getAccessibilityTree()).rejects.toThrow(NotImplementedError);
      await expect(backend.getAccessibilityTree()).rejects.toThrow('v1.5');
    });

    it('queryElements should throw NotImplementedError', async () => {
      await expect(backend.queryElements('.button')).rejects.toThrow(NotImplementedError);
      await expect(backend.queryElements('.button')).rejects.toThrow('v1.5');
    });

    it('handleAlert should throw NotImplementedError', async () => {
      await expect(backend.handleAlert('accept')).rejects.toThrow(NotImplementedError);
      await expect(backend.handleAlert('accept')).rejects.toThrow('v1.5');
    });
  });

  describe('v2 stubs (NotImplementedError)', () => {
    let backend: SimctlNativeBackend;

    beforeAll(() => {
      backend = new SimctlNativeBackend(createMockSimctl());
    });

    it('tap should throw NotImplementedError', async () => {
      await expect(backend.tap({ x: 100, y: 200 })).rejects.toThrow(NotImplementedError);
      await expect(backend.tap({ x: 100, y: 200 })).rejects.toThrow('v2');
    });

    it('typeText should throw NotImplementedError', async () => {
      await expect(backend.typeText('input', 'hello')).rejects.toThrow(NotImplementedError);
      await expect(backend.typeText('input', 'hello')).rejects.toThrow('v2');
    });

    it('swipe should throw NotImplementedError', async () => {
      await expect(backend.swipe('up')).rejects.toThrow(NotImplementedError);
      await expect(backend.swipe('up')).rejects.toThrow('v2');
    });
  });
});
