/**
 * Unit tests for flutter_build_mode (issue #442).
 */

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockGetIsolate = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    getIsolate: mockGetIsolate,
  }),
}));

const mockDiscoverVMServiceUrl = jest.fn();
jest.mock('../../src/flutter/vm-service-discovery', () => ({
  discoverVMServiceUrl: (...args: unknown[]) => mockDiscoverVMServiceUrl(...args),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('flutter_build_mode', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterBuildModeTool } = require('../../src/tools/flutter-build-mode');
    registerFlutterBuildModeTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers with the expected name', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterBuildModeTool } = require('../../src/tools/flutter-build-mode');
    registerFlutterBuildModeTool(server);
    expect(server.registerTool.mock.calls[0][0].name).toBe('flutter_build_mode');
  });

  it('reports debug mode when hot-reload extension is present on connected isolate', async () => {
    mockIsConnected.mockReturnValue(true);
    mockGetIsolate.mockResolvedValue({
      extensionRPCs: ['ext.flutter.reassemble', 'ext.flutter.debugDumpApp'],
    });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.mode).toBe('debug');
    expect(body.vm_service_available).toBe(true);
    expect(body.capabilities.hot_reload).toBe(true);
    expect(body.capabilities.evaluate).toBe(true);
    expect(body.capabilities.breakpoints).toBe(true);
    expect(body.fallback_tools).toEqual([]);
  });

  it('reports profile mode when connected but reassemble extension is missing', async () => {
    mockIsConnected.mockReturnValue(true);
    mockGetIsolate.mockResolvedValue({
      extensionRPCs: ['ext.flutter.debugDumpApp'],
    });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.mode).toBe('profile');
    expect(body.capabilities.hot_reload).toBe(false);
    expect(body.capabilities.evaluate).toBe(true);
    expect(body.capabilities.breakpoints).toBe(false);
  });

  it('reports release mode when no VM Service URL is discoverable', async () => {
    mockIsConnected.mockReturnValue(false);
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.mode).toBe('release');
    expect(body.vm_service_available).toBe(false);
    expect(body.capabilities.hot_reload).toBe(false);
    expect(body.capabilities.widget_tree).toBe(false);
    expect(body.fallback_tools).toContain('app_tap_element');
    expect(body.fallback_tools).toContain('app_screenshot_native');
    expect(body.capabilities.ui_automation).toBe(true);
    expect(body.capabilities.screenshot).toBe(true);
    expect(body.capabilities.network_proxy).toBe(true);
  });

  it('reports unknown mode when a VM Service URL is discoverable but no client connected yet', async () => {
    mockIsConnected.mockReturnValue(false);
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:55555/abc=/');

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    // URL alone cannot distinguish debug from profile — caller should connect.
    expect(body.mode).toBe('unknown');
    expect(body.vm_service_available).toBe(true);
    expect(body.details).toContain('127.0.0.1');
    expect(body.details).toContain('flutter_connect');
  });

  it('surfaces discovery errors in details and still reports release as fallback', async () => {
    mockIsConnected.mockReturnValue(false);
    mockDiscoverVMServiceUrl.mockRejectedValue(new Error('log predicate blew up'));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.mode).toBe('release');
    expect(body.vm_service_available).toBe(false);
    expect(body.details).toContain('log predicate blew up');
    expect(body.details.toLowerCase()).toContain('transient');
  });

  it('forwards bundle_id and timeout_ms to discovery', async () => {
    mockIsConnected.mockReturnValue(false);
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    await handler('s', { bundle_id: 'com.example.app', timeout_ms: 2000 });

    expect(mockDiscoverVMServiceUrl).toHaveBeenCalledWith(
      'test-device-id',
      expect.objectContaining({ bundleId: 'com.example.app', timeout: 2000 }),
    );
  });

  it('returns structured error when no device is available', async () => {
    jest.isolateModules(() => {
      jest.resetModules();
      jest.doMock('../../src/session-manager', () => ({
        getSessionManager: () => ({ getSoleDeviceId: () => null }),
      }));
      jest.doMock('../../src/flutter', () => ({
        getFlutterVMClient: () => ({ isConnected: () => false, getIsolate: jest.fn() }),
      }));
      jest.doMock('../../src/flutter/vm-service-discovery', () => ({
        discoverVMServiceUrl: jest.fn().mockResolvedValue(null),
      }));

      const server = { registerTool: jest.fn() };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../src/tools/flutter-build-mode');
      mod.registerFlutterBuildModeTool(server);
      const localHandler: (s: string, p: Record<string, unknown>) => Promise<ToolResult> =
        server.registerTool.mock.calls[0][1];
      return localHandler('s', {}).then((r) => {
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain('No device');
      });
    });
  });
});
