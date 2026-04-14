/**
 * Unit tests for flutter_list_service_extensions + flutter_call_service_extension (issue #441).
 */

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockGetIsolate = jest.fn();
const mockCallMethod = jest.fn();
const mockGetState = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    getIsolate: mockGetIsolate,
    callMethod: mockCallMethod,
    getState: mockGetState,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('flutter_list_service_extensions', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterListServiceExtensionsTool } = require('../../src/tools/flutter-service-extensions');
    registerFlutterListServiceExtensionsTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  it('registers with the expected name', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterListServiceExtensionsTool } = require('../../src/tools/flutter-service-extensions');
    registerFlutterListServiceExtensionsTool(server);
    expect(server.registerTool.mock.calls[0][0].name).toBe('flutter_list_service_extensions');
  });

  it('returns all extensions and groups by namespace', async () => {
    mockGetIsolate.mockResolvedValue({
      extensionRPCs: [
        'ext.flutter.debugPaint',
        'ext.flutter.inspector.show',
        'ext.riverpod.providers',
      ],
    });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.count).toBe(3);
    expect(body.total_registered).toBe(3);
    expect(body.extensions).toEqual([
      'ext.flutter.debugPaint',
      'ext.flutter.inspector.show',
      'ext.riverpod.providers',
    ]);
    expect(body.namespaces['ext.flutter']).toContain('ext.flutter.debugPaint');
    expect(body.namespaces['ext.flutter.inspector']).toContain('ext.flutter.inspector.show');
    expect(body.namespaces['ext.riverpod']).toContain('ext.riverpod.providers');
  });

  it('filters by prefix', async () => {
    mockGetIsolate.mockResolvedValue({
      extensionRPCs: [
        'ext.flutter.debugPaint',
        'ext.flutter.inspector.show',
        'ext.riverpod.providers',
      ],
    });

    const result = await handler('s', { prefix: 'ext.riverpod.' });
    const body = JSON.parse(result.content[0].text);

    expect(body.count).toBe(1);
    expect(body.total_registered).toBe(3);
    expect(body.extensions).toEqual(['ext.riverpod.providers']);
  });

  it('handles isolate with no extensionRPCs array', async () => {
    mockGetIsolate.mockResolvedValue({}); // missing field
    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(0);
    expect(body.extensions).toEqual([]);
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });
});

describe('flutter_call_service_extension', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterCallServiceExtensionTool } = require('../../src/tools/flutter-service-extensions');
    registerFlutterCallServiceExtensionTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('registers with the expected name and required field', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterCallServiceExtensionTool } = require('../../src/tools/flutter-service-extensions');
    registerFlutterCallServiceExtensionTool(server);
    const def = server.registerTool.mock.calls[0][0];
    expect(def.name).toBe('flutter_call_service_extension');
    expect(def.inputSchema.required).toEqual(['extension']);
  });

  it('invokes the extension with isolateId auto-injected', async () => {
    mockCallMethod.mockResolvedValue({ providers: [] });

    const result = await handler('s', {
      extension: 'ext.riverpod.providers',
      args: { scope: 'global' },
    });
    const body = JSON.parse(result.content[0].text);

    expect(mockCallMethod).toHaveBeenCalledWith('ext.riverpod.providers', {
      isolateId: 'iso-1',
      scope: 'global',
    });
    expect(body.status).toBe('ok');
    expect(body.result).toEqual({ providers: [] });
  });

  it('works without args', async () => {
    mockCallMethod.mockResolvedValue({});
    await handler('s', { extension: 'ext.flutter.debugPaint' });
    expect(mockCallMethod).toHaveBeenCalledWith('ext.flutter.debugPaint', {
      isolateId: 'iso-1',
    });
  });

  it('rejects missing extension', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extension is required');
  });

  it('rejects empty or whitespace extension', async () => {
    const r1 = await handler('s', { extension: '' });
    const r2 = await handler('s', { extension: '   ' });
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
  });

  it('rejects extension without ext. prefix', async () => {
    const result = await handler('s', { extension: 'flutter.debugPaint' });
    expect(result.isError).toBe(true);
    // The message survives JSON.stringify, which escapes the inner quotes.
    expect(result.content[0].text).toContain('must start with');
    expect(result.content[0].text).toContain('flutter.debugPaint');
  });

  it('rejects non-object args', async () => {
    const result = await handler('s', { extension: 'ext.foo', args: 'oops' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('args must be an object');
  });

  it('rejects array args', async () => {
    const result = await handler('s', { extension: 'ext.foo', args: [1, 2] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('args must be an object');
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { extension: 'ext.foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });

  it('logs an audit message for every call', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCallMethod.mockResolvedValue({});
    await handler('s', { extension: 'ext.riverpod.providers' });
    const auditCall = spy.mock.calls.find((c) => String(c[0]).includes('audit'));
    expect(auditCall).toBeDefined();
    expect(String(auditCall?.[0])).toContain('ext.riverpod.providers');
    spy.mockRestore();
  });

  it('propagates RPC errors as tool errors', async () => {
    mockCallMethod.mockRejectedValue(new Error('RPC_ERROR: extension not registered'));
    const result = await handler('s', { extension: 'ext.unknown' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not registered');
  });
});
