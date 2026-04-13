/**
 * Unit tests for flutter_toggle_debug_paint (issue #437).
 */

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockCallServiceExtension = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    callServiceExtension: mockCallServiceExtension,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('flutter_toggle_debug_paint', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterDebugPaintTool } = require('../../src/tools/flutter-debug-paint');
    registerFlutterDebugPaintTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockCallServiceExtension.mockResolvedValue({});
  });

  it('registers with the expected name and required field', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterDebugPaintTool } = require('../../src/tools/flutter-debug-paint');
    registerFlutterDebugPaintTool(server);
    const def = server.registerTool.mock.calls[0][0];
    expect(def.name).toBe('flutter_toggle_debug_paint');
    expect(def.inputSchema.required).toEqual(['mode']);
  });

  it('toggles layout bounds (size mode, enable=true)', async () => {
    const result = await handler('s', { mode: 'size', enable: true });
    const body = JSON.parse(result.content[0].text);

    expect(mockCallServiceExtension).toHaveBeenCalledWith('debugPaint', { enabled: 'true' });
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('size');
    expect(body.applied[0].extension).toBe('ext.flutter.debugPaint');
  });

  it('disables baseline paint (enable=false)', async () => {
    const result = await handler('s', { mode: 'baseline', enable: false });
    expect(result.isError).toBeUndefined();
    expect(mockCallServiceExtension).toHaveBeenCalledWith('debugPaintBaselinesEnabled', { enabled: 'false' });
  });

  it('toggles repaint rainbow', async () => {
    await handler('s', { mode: 'repaint_rainbow', enable: true });
    expect(mockCallServiceExtension).toHaveBeenCalledWith('repaintRainbow', { enabled: 'true' });
  });

  it('applies time dilation', async () => {
    await handler('s', { mode: 'time_dilation', dilation_factor: 2.5 });
    expect(mockCallServiceExtension).toHaveBeenCalledWith('timeDilation', { timeDilation: '2.5' });
  });

  it('rejects invalid dilation_factor (negative)', async () => {
    const result = await handler('s', { mode: 'time_dilation', dilation_factor: -1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('positive number');
    expect(mockCallServiceExtension).not.toHaveBeenCalled();
  });

  it('rejects missing dilation_factor', async () => {
    const result = await handler('s', { mode: 'time_dilation' });
    expect(result.isError).toBe(true);
  });

  it('rejects missing enable flag for size/baseline/repaint_rainbow', async () => {
    const result = await handler('s', { mode: 'size' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires enable');
  });

  it('all_off resets every flag including time dilation', async () => {
    const result = await handler('s', { mode: 'all_off' });
    const body = JSON.parse(result.content[0].text);

    const extCalls = mockCallServiceExtension.mock.calls.map((c) => c[0]);
    expect(extCalls).toEqual(expect.arrayContaining([
      'debugPaint',
      'debugPaintBaselinesEnabled',
      'repaintRainbow',
      'timeDilation',
    ]));
    const timeDilationCall = mockCallServiceExtension.mock.calls.find((c) => c[0] === 'timeDilation');
    expect(timeDilationCall?.[1]).toEqual({ timeDilation: '1.0' });
    expect(body.applied).toHaveLength(4);
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { mode: 'size', enable: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
    expect(mockCallServiceExtension).not.toHaveBeenCalled();
  });

  it('errors when mode is missing', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('mode is required');
  });
});
