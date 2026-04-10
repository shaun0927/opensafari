import { MCPServer } from '../../src/mcp-server';
import { registerAppScreenshotNativeTool } from '../../src/tools/app-screenshot-native';
import { registerAppLogsTool } from '../../src/tools/app-logs';
import { registerAppCrashReportsTool } from '../../src/tools/app-crash-reports';
import { registerAppRecordVideoTool, _clearRecordings, _getRecordings } from '../../src/tools/app-record-video';
import { buildLogPredicate } from '../../src/tools/app-logs';
import { parseDuration, resolveDeviceId, tempPath } from '../../src/tools/native-observability-utils';
import { getSessionManager } from '../../src/session-manager';

// ── Utility tests ──────────────────────────────────────────────────────────

describe('native-observability-utils', () => {
  describe('parseDuration', () => {
    test('accepts valid durations', () => {
      expect(parseDuration('5m')).toBe('5m');
      expect(parseDuration('1h')).toBe('1h');
      expect(parseDuration('30s')).toBe('30s');
      expect(parseDuration('2d')).toBe('2d');
    });

    test('rejects invalid durations', () => {
      expect(() => parseDuration('abc')).toThrow('Invalid duration format');
      expect(() => parseDuration('5x')).toThrow('Invalid duration format');
      expect(() => parseDuration('')).toThrow('Invalid duration format');
      expect(() => parseDuration('m5')).toThrow('Invalid duration format');
    });
  });

  describe('resolveDeviceId', () => {
    test('returns deviceId from params when provided', () => {
      expect(resolveDeviceId({ deviceId: 'ABCD-1234' })).toBe('ABCD-1234');
    });

    test('falls back to active device', () => {
      const sm = getSessionManager();
      sm.addSimulator('ACTIVE-001', {
        deviceId: 'ACTIVE-001',
        deviceType: 'iPhone 15',
        state: 'booted',
        viewport: { width: 390, height: 844 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
      expect(resolveDeviceId({})).toBe('ACTIVE-001');
      sm.removeSimulator('ACTIVE-001');
    });

    test('throws when no device available', () => {
      // Ensure no active device
      const sm = getSessionManager();
      const activeId = sm.getSoleDeviceId();
      if (activeId) sm.removeSimulator(activeId);
      expect(() => resolveDeviceId({})).toThrow('No device specified');
    });
  });

  describe('tempPath', () => {
    test('generates path with correct extension', () => {
      const p = tempPath('png');
      expect(p).toMatch(/opensafari-.*\.png$/);
    });

    test('generates unique paths', () => {
      const a = tempPath('mp4');
      const b = tempPath('mp4');
      expect(a).not.toBe(b);
    });
  });
});

// ── Log predicate builder ──────────────────────────────────────────────────

describe('buildLogPredicate', () => {
  test('returns null when no filters', () => {
    expect(buildLogPredicate({})).toBeNull();
  });

  test('builds predicate for bundleId', () => {
    const p = buildLogPredicate({ bundleId: 'com.example.app' });
    expect(p).toBe('process == "com.example.app"');
  });

  test('builds predicate for error level', () => {
    const p = buildLogPredicate({ level: 'error' });
    expect(p).toBe('messageType >= 16');
  });

  test('builds predicate for fault level', () => {
    const p = buildLogPredicate({ level: 'fault' });
    expect(p).toBe('messageType >= 17');
  });

  test('skips default level (messageType 0)', () => {
    const p = buildLogPredicate({ level: 'default' });
    expect(p).toBeNull();
  });

  test('builds predicate for search', () => {
    const p = buildLogPredicate({ search: 'crash' });
    expect(p).toBe('composedMessage CONTAINS "crash"');
  });

  test('combines multiple filters with AND', () => {
    const p = buildLogPredicate({ bundleId: 'com.example.app', level: 'error', search: 'fatal' });
    expect(p).toContain('process == "com.example.app"');
    expect(p).toContain('AND');
    expect(p).toContain('messageType >= 16');
    expect(p).toContain('composedMessage CONTAINS "fatal"');
  });

  test('escapes double quotes in search', () => {
    const p = buildLogPredicate({ search: 'error "test"' });
    expect(p).toContain('error \\"test\\"');
  });
});

// ── Tool registration tests ────────────────────────────────────────────────

describe('app_screenshot_native tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppScreenshotNativeTool(server);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_screenshot_native');
  });

  test('returns error when no device available', async () => {
    const sm = getSessionManager();
    const activeId = sm.getSoleDeviceId();
    if (activeId) sm.removeSimulator(activeId);

    const handler = server.getToolHandler('app_screenshot_native')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No device specified');
  });
});

describe('app_logs tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppLogsTool(server);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_logs');
  });

  test('returns error when no device available', async () => {
    const sm = getSessionManager();
    const activeId = sm.getSoleDeviceId();
    if (activeId) sm.removeSimulator(activeId);

    const handler = server.getToolHandler('app_logs')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No device specified');
  });

  test('returns error for invalid duration', async () => {
    const sm = getSessionManager();
    sm.addSimulator('LOG-DEV', {
      deviceId: 'LOG-DEV',
      deviceType: 'iPhone 15',
      state: 'booted',
      viewport: { width: 390, height: 844 },
      bootedAt: Date.now(),
      lastActivity: Date.now(),
    });

    const handler = server.getToolHandler('app_logs')!;
    const result = await handler('test', { since: 'invalid' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('Invalid duration format');

    sm.removeSimulator('LOG-DEV');
  });
});

describe('app_crash_reports tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppCrashReportsTool(server);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_crash_reports');
  });

  test('returns error when no device available', async () => {
    const sm = getSessionManager();
    const activeId = sm.getSoleDeviceId();
    if (activeId) sm.removeSimulator(activeId);

    const handler = server.getToolHandler('app_crash_reports')!;
    const result = await handler('test', {});
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No device specified');
  });
});

describe('app_record_video tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppRecordVideoTool(server);
  });

  afterEach(() => {
    _clearRecordings();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_record_video');
  });

  test('returns error when no device available', async () => {
    const sm = getSessionManager();
    const activeId = sm.getSoleDeviceId();
    if (activeId) sm.removeSimulator(activeId);

    const handler = server.getToolHandler('app_record_video')!;
    const result = await handler('test', { action: 'start' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No device specified');
  });

  test('returns error when stopping without active recording', async () => {
    const sm = getSessionManager();
    sm.addSimulator('VID-DEV', {
      deviceId: 'VID-DEV',
      deviceType: 'iPhone 15',
      state: 'booted',
      viewport: { width: 390, height: 844 },
      bootedAt: Date.now(),
      lastActivity: Date.now(),
    });

    const handler = server.getToolHandler('app_record_video')!;
    const result = await handler('test', { action: 'stop', deviceId: 'VID-DEV' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No active recording');

    sm.removeSimulator('VID-DEV');
  });

  test('prevents duplicate recordings on same device', async () => {
    // Simulate an existing recording in the map
    const recordings = _getRecordings();
    recordings.set('DUP-DEV', {
      process: {} as any,
      filePath: '/tmp/test.mp4',
      startedAt: new Date().toISOString(),
      deviceId: 'DUP-DEV',
    });

    const sm = getSessionManager();
    sm.addSimulator('DUP-DEV', {
      deviceId: 'DUP-DEV',
      deviceType: 'iPhone 15',
      state: 'booted',
      viewport: { width: 390, height: 844 },
      bootedAt: Date.now(),
      lastActivity: Date.now(),
    });

    const handler = server.getToolHandler('app_record_video')!;
    const result = await handler('test', { action: 'start', deviceId: 'DUP-DEV' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('already in progress');

    sm.removeSimulator('DUP-DEV');
  });
});
