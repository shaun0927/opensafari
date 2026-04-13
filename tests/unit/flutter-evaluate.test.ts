/**
 * Unit tests for flutter_evaluate (issue #434).
 */

import { shapeResult } from '../../src/tools/flutter-evaluate';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockEvaluate = jest.fn();
const mockEvaluateInFrame = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    evaluate: mockEvaluate,
    evaluateInFrame: mockEvaluateInFrame,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('shapeResult', () => {
  it('shapes a primitive Int instance', () => {
    const shaped = shapeResult({
      type: '@Instance',
      kind: 'Int',
      class: { name: 'int' },
      valueAsString: '42',
    });
    expect(shaped).toEqual({ kind: 'Int', classRef: 'int', valueAsString: '42' });
  });

  it('shapes a primitive Bool', () => {
    const shaped = shapeResult({
      type: '@Instance',
      kind: 'Bool',
      class: { name: 'bool' },
      valueAsString: 'true',
    });
    expect(shaped.valueAsString).toBe('true');
    expect(shaped.kind).toBe('Bool');
  });

  it('shapes a composite instance with 1-depth fields', () => {
    const shaped = shapeResult({
      type: '@Instance',
      kind: 'PlainInstance',
      id: 'objects/1',
      class: { name: 'User' },
      fields: [
        { decl: { name: 'name' }, value: { kind: 'String', valueAsString: 'Jane' } },
        { decl: { name: 'age' }, value: { kind: 'Int', valueAsString: '30' } },
      ],
    });
    expect(shaped.kind).toBe('PlainInstance');
    expect(shaped.classRef).toBe('User');
    expect(shaped.id).toBe('objects/1');
    expect(shaped.fields).toEqual(['name', 'age']);
  });

  it('shapes a Sentinel', () => {
    const shaped = shapeResult({
      type: 'Sentinel',
      kind: 'Collected',
      valueAsString: '<collected>',
    });
    expect(shaped.kind).toBe('Sentinel');
    expect(shaped.valueAsString).toBe('<collected>');
    expect(shaped.sentinelKind).toBe('Collected');
  });

  it('shapes an Error envelope', () => {
    const shaped = shapeResult({
      type: '@Error',
      kind: 'UnhandledException',
      message: 'expression failed',
    });
    expect(shaped.kind).toBe('Error');
    expect(shaped.message).toBe('expression failed');
  });
});

describe('flutter_evaluate handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterEvaluateTool } = require('../../src/tools/flutter-evaluate');
    registerFlutterEvaluateTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  it('registers with the expected name and required field', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterEvaluateTool } = require('../../src/tools/flutter-evaluate');
    registerFlutterEvaluateTool(server);
    const def = server.registerTool.mock.calls[0][0];
    expect(def.name).toBe('flutter_evaluate');
    expect(def.inputSchema.required).toEqual(['expression']);
  });

  it('evaluates against root library scope by default', async () => {
    mockEvaluate.mockResolvedValue({
      type: '@Instance',
      kind: 'Int',
      class: { name: 'int' },
      valueAsString: '2',
    });

    const result = await handler('s', { expression: '1 + 1' });
    const body = JSON.parse(result.content[0].text);

    expect(mockEvaluate).toHaveBeenCalledWith('1 + 1');
    expect(mockEvaluateInFrame).not.toHaveBeenCalled();
    expect(body.status).toBe('ok');
    expect(body.scope).toBe('root');
    expect(body.result.valueAsString).toBe('2');
  });

  it('evaluates inside a paused frame when scope="frame"', async () => {
    mockEvaluateInFrame.mockResolvedValue({
      type: '@Instance',
      kind: 'String',
      class: { name: 'String' },
      valueAsString: 'hi',
    });

    const result = await handler('s', { expression: 'x', scope: 'frame', frame_index: 2 });
    const body = JSON.parse(result.content[0].text);

    expect(mockEvaluateInFrame).toHaveBeenCalledWith(2, 'x');
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(body.scope).toBe('frame');
    expect(body.frameIndex).toBe(2);
    expect(body.result.valueAsString).toBe('hi');
  });

  it('rejects scope="frame" without frame_index', async () => {
    const result = await handler('s', { expression: 'x', scope: 'frame' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('frame_index');
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockEvaluateInFrame).not.toHaveBeenCalled();
  });

  it('rejects negative frame_index', async () => {
    const result = await handler('s', { expression: 'x', scope: 'frame', frame_index: -1 });
    expect(result.isError).toBe(true);
  });

  it('rejects missing expression', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('expression is required');
  });

  it('rejects unknown scope value', async () => {
    const result = await handler('s', { expression: 'x', scope: 'global' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('scope');
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { expression: '1+1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });

  it('propagates RPC errors from evaluate as tool errors', async () => {
    mockEvaluate.mockRejectedValue(new Error('REQUEST_TIMEOUT: evaluate'));
    const result = await handler('s', { expression: '1+1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('REQUEST_TIMEOUT');
  });
});

// ── FlutterVMClient.evaluate (VM client helper) ───────────────────────────

describe('FlutterVMClient.evaluate', () => {
  let FlutterVMClient: typeof import('../../src/flutter/vm-service-client').FlutterVMClient;

  beforeAll(async () => {
    const mod = await import('../../src/flutter/vm-service-client');
    FlutterVMClient = mod.FlutterVMClient;
  });

  it('resolves root library and forwards evaluate RPC', async () => {
    const client = new FlutterVMClient();
    const callMethod = jest.fn()
      .mockImplementationOnce(async (method: string) => {
        expect(method).toBe('getIsolate');
        return { rootLib: { id: 'libraries/42' } };
      })
      .mockImplementationOnce(async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe('evaluate');
        expect(params).toEqual({
          isolateId: 'iso-1',
          targetId: 'libraries/42',
          expression: '1+1',
        });
        return { type: '@Instance', kind: 'Int', class: { name: 'int' }, valueAsString: '2' };
      });

    (client as unknown as { state: unknown }).state = { mainIsolateId: 'iso-1', connected: true };
    (client as unknown as { callMethod: unknown }).callMethod = callMethod;

    const res = await client.evaluate('1+1');
    expect((res as { valueAsString?: string }).valueAsString).toBe('2');
  });

  it('throws NO_ISOLATE when mainIsolateId is missing', async () => {
    const client = new FlutterVMClient();
    await expect(client.evaluate('1+1')).rejects.toThrow('No main isolate');
  });

  it('evaluateInFrame forwards frameIndex', async () => {
    const client = new FlutterVMClient();
    const callMethod = jest.fn().mockResolvedValue({
      type: '@Instance', kind: 'Int', valueAsString: '5',
    });
    (client as unknown as { state: unknown }).state = { mainIsolateId: 'iso-1', connected: true };
    (client as unknown as { callMethod: unknown }).callMethod = callMethod;

    await client.evaluateInFrame(3, 'x');
    expect(callMethod).toHaveBeenCalledWith('evaluateInFrame', {
      isolateId: 'iso-1',
      frameIndex: 3,
      expression: 'x',
    });
  });
});
