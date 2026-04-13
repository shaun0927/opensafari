/**
 * Unit tests for Flutter VM Service module:
 *   - vm-service-discovery.ts (URL parsing)
 *   - vm-service-client.ts (client lifecycle)
 *   - flutter-connect.ts, flutter-widget-tree.ts, flutter-hot-reload.ts, flutter-logs.ts (MCP tools)
 */

import { httpToWsUrl, isValidVMServiceUrl } from '../../src/flutter/vm-service-discovery';

// ── URL Discovery Tests ──────────────────────────────────────────────────────

describe('vm-service-discovery', () => {
  describe('httpToWsUrl', () => {
    it('converts HTTP URL to WebSocket URL', () => {
      expect(httpToWsUrl('http://127.0.0.1:50642/abc=/'))
        .toBe('ws://127.0.0.1:50642/abc=/ws');
    });

    it('converts HTTPS URL to WSS URL', () => {
      expect(httpToWsUrl('https://127.0.0.1:50642/abc=/'))
        .toBe('wss://127.0.0.1:50642/abc=/ws');
    });

    it('handles URL without trailing slash', () => {
      expect(httpToWsUrl('http://127.0.0.1:50642/abc='))
        .toBe('ws://127.0.0.1:50642/abc=/ws');
    });

    it('handles complex auth tokens', () => {
      expect(httpToWsUrl('http://127.0.0.1:12345/a1b2c3d4e5f6=/'))
        .toBe('ws://127.0.0.1:12345/a1b2c3d4e5f6=/ws');
    });
  });

  describe('isValidVMServiceUrl', () => {
    it('validates correct VM Service URLs', () => {
      expect(isValidVMServiceUrl('http://127.0.0.1:50642/abc=/')).toBe(true);
      expect(isValidVMServiceUrl('http://127.0.0.1:12345/a1b2c3d4e5f6=/')).toBe(true);
    });

    it('rejects invalid URLs', () => {
      expect(isValidVMServiceUrl('http://example.com')).toBe(false);
      expect(isValidVMServiceUrl('not a url')).toBe(false);
      expect(isValidVMServiceUrl('')).toBe(false);
    });
  });
});

// ── FlutterVMClient Tests ────────────────────────────────────────────────────

describe('FlutterVMClient', () => {
  let FlutterVMClient: typeof import('../../src/flutter/vm-service-client').FlutterVMClient;

  beforeAll(async () => {
    const mod = await import('../../src/flutter/vm-service-client');
    FlutterVMClient = mod.FlutterVMClient;
  });

  it('starts disconnected', () => {
    const client = new FlutterVMClient();
    expect(client.isConnected()).toBe(false);
    expect(client.getState()).toBeNull();
  });

  it('throws NOT_CONNECTED when calling methods without connection', async () => {
    const client = new FlutterVMClient();
    await expect(client.callMethod('getVM')).rejects.toThrow('Not connected');
  });

  it('throws NO_ISOLATE when calling service extension without isolate', async () => {
    const client = new FlutterVMClient();
    // Manually set state without isolate
    (client as unknown as Record<string, unknown>).state = {
      connected: true,
      mainIsolateId: null,
    };
    (client as unknown as Record<string, unknown>).ws = { readyState: 1 }; // OPEN

    await expect(client.callServiceExtension('debugDumpApp')).rejects.toThrow('No main isolate');
  });

  it('disconnect clears state', async () => {
    const client = new FlutterVMClient();
    (client as unknown as Record<string, unknown>).state = {
      connected: true,
      httpUrl: 'http://127.0.0.1:50642/abc=/',
      wsUrl: 'ws://127.0.0.1:50642/abc=/ws',
      deviceId: 'test',
    };
    (client as unknown as Record<string, unknown>).ws = {
      close: jest.fn(),
      readyState: 1,
    };

    await client.disconnect();

    expect(client.getState()?.connected).toBe(false);
  });
});

// ── FlutterVMError Tests ─────────────────────────────────────────────────────

describe('FlutterVMError', () => {
  it('has correct name and code', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FlutterVMError } = require('../../src/flutter/vm-service-client');
    const err = new FlutterVMError('test error', 'TEST_CODE');
    expect(err.name).toBe('FlutterVMError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test error');
    expect(err instanceof Error).toBe(true);
  });
});

// ── Tool Registration Tests ──────────────────────────────────────────────────

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

describe('Flutter tool registration', () => {
  const mockServer = {
    registerTool: jest.fn(),
  };

  beforeEach(() => {
    mockServer.registerTool.mockClear();
  });

  it('registers flutter_connect', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterConnectTool } = require('../../src/tools/flutter-connect');
    registerFlutterConnectTool(mockServer);
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
  });

  it('registers flutter_widget_tree', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterWidgetTreeTool } = require('../../src/tools/flutter-widget-tree');
    registerFlutterWidgetTreeTool(mockServer);
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
  });

  it('registers flutter_hot_reload', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterHotReloadTool } = require('../../src/tools/flutter-hot-reload');
    registerFlutterHotReloadTool(mockServer);
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
  });

  it('registers flutter_logs', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterLogsTool } = require('../../src/tools/flutter-logs');
    registerFlutterLogsTool(mockServer);
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
  });
});

// ── Tool Handler Tests (flutter_widget_tree, flutter_hot_reload) ─────────────

const mockGetWidgetTree = jest.fn();
const mockGetRenderTree = jest.fn();
const mockGetSemanticsTree = jest.fn();
const mockHotReload = jest.fn();
const mockHotRestart = jest.fn();
const mockIsConnected = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    getWidgetTree: mockGetWidgetTree,
    getRenderTree: mockGetRenderTree,
    getSemanticsTree: mockGetSemanticsTree,
    hotReload: mockHotReload,
    hotRestart: mockHotRestart,
  }),
}));

describe('flutter_widget_tree handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterWidgetTreeTool } = require('../../src/tools/flutter-widget-tree');
    registerFlutterWidgetTreeTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns widget tree when connected', async () => {
    mockIsConnected.mockReturnValue(true);
    mockGetWidgetTree.mockResolvedValue('MyApp\n  MaterialApp\n    Scaffold');

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.tree_type).toBe('widget');
    expect(body.dump).toContain('MyApp');
  });

  it('returns render tree', async () => {
    mockIsConnected.mockReturnValue(true);
    mockGetRenderTree.mockResolvedValue('RenderView\n  RenderBox');

    const result = await handler('s', { tree_type: 'render' });
    const body = JSON.parse(result.content[0].text);

    expect(body.tree_type).toBe('render');
    expect(body.dump).toContain('RenderView');
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);

    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });
});

describe('flutter_hot_reload handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterHotReloadTool } = require('../../src/tools/flutter-hot-reload');
    registerFlutterHotReloadTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('triggers hot reload', async () => {
    mockIsConnected.mockReturnValue(true);
    mockHotReload.mockResolvedValue({ type: 'ReloadReport', success: true });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('reloaded');
    expect(body.mode).toBe('reload');
    expect(mockHotReload).toHaveBeenCalled();
  });

  it('triggers hot restart', async () => {
    mockIsConnected.mockReturnValue(true);
    mockHotRestart.mockResolvedValue({});

    const result = await handler('s', { mode: 'restart' });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('restarted');
    expect(body.mode).toBe('restart');
    expect(mockHotRestart).toHaveBeenCalled();
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);

    const result = await handler('s', {});
    expect(result.isError).toBe(true);
  });
});
