/**
 * Unit tests for the breakpoint / step-debugging tool suite (issue #435).
 */

import {
  resumeModeToStep,
  summariseFrame,
  forgetBreakpointManager,
  _resetBreakpointManagers,
} from '../../src/tools/flutter-breakpoints';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockCallMethod = jest.fn();
const mockGetState = jest.fn();
const mockStreamListen = jest.fn();
const mockOnEvent = jest.fn();
const mockOffEvent = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    callMethod: mockCallMethod,
    getState: mockGetState,
    streamListen: mockStreamListen,
    onEvent: mockOnEvent,
    offEvent: mockOffEvent,
  }),
  FlutterVMError: class extends Error {
    constructor(msg: string, public readonly code: string) { super(msg); }
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── resumeModeToStep ────────────────────────────────────────────────────────

describe('resumeModeToStep', () => {
  it('maps each mode to the expected VM step token', () => {
    expect(resumeModeToStep('continue')).toBeUndefined();
    expect(resumeModeToStep('step_into')).toBe('Into');
    expect(resumeModeToStep('step_over')).toBe('Over');
    expect(resumeModeToStep('step_out')).toBe('Out');
  });

  it('throws on unknown mode', () => {
    // @ts-expect-error — runtime check
    expect(() => resumeModeToStep('warp')).toThrow('Unknown resume mode');
  });
});

// ── summariseFrame ──────────────────────────────────────────────────────────

describe('summariseFrame', () => {
  it('extracts index, function, kind, location, vars', () => {
    const s = summariseFrame({
      index: 0,
      kind: 'Regular',
      function: { name: 'build' },
      location: {
        script: { uri: 'package:app/home.dart' },
        tokenPos: 123,
        line: 47,
        column: 12,
      },
      vars: [{ name: 'context' }, { name: 'widget' }, { noName: true }],
    });

    expect(s.index).toBe(0);
    expect(s.function).toBe('build');
    expect(s.kind).toBe('Regular');
    expect(s.location).toEqual({
      script_uri: 'package:app/home.dart',
      token_pos: 123,
      line: 47,
      column: 12,
    });
    expect(s.vars).toEqual(['context', 'widget']);
  });

  it('tolerates missing fields', () => {
    const s = summariseFrame({});
    expect(s.index).toBe(0);
    expect(s.function).toBeUndefined();
    expect(s.location).toBeUndefined();
    expect(s.vars).toBeUndefined();
  });
});

// ── flutter_set_breakpoint ──────────────────────────────────────────────────

describe('flutter_set_breakpoint handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterSetBreakpointTool } = require('../../src/tools/flutter-breakpoints');
    registerFlutterSetBreakpointTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetBreakpointManagers();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockStreamListen.mockResolvedValue(undefined);
  });

  it('rejects missing script_uri', async () => {
    const result = await handler('s', { line: 42 });
    expect(result.isError).toBe(true);
  });

  it('rejects non-integer / non-positive line', async () => {
    const r1 = await handler('s', { script_uri: 'package:a/b.dart', line: 0 });
    const r2 = await handler('s', { script_uri: 'package:a/b.dart', line: 1.5 });
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
  });

  it('subscribes to Debug stream and calls addBreakpointWithScriptUri with isolate and line', async () => {
    mockCallMethod.mockResolvedValue({
      id: 'breakpoints/7',
      resolved: true,
      location: { script: { uri: 'package:a/b.dart' }, line: 42 },
    });

    const result = await handler('s', { script_uri: 'package:a/b.dart', line: 42 });
    const body = JSON.parse(result.content[0].text);

    expect(mockStreamListen).toHaveBeenCalledWith('Debug');
    expect(mockOnEvent).toHaveBeenCalledWith('Debug', expect.any(Function));
    expect(mockCallMethod).toHaveBeenCalledWith('addBreakpointWithScriptUri', {
      isolateId: 'iso-1',
      scriptUri: 'package:a/b.dart',
      line: 42,
    });
    expect(body.status).toBe('ok');
    expect(body.breakpoint.id).toBe('breakpoints/7');
    expect(body.breakpoint.resolved).toBe(true);
  });

  it('forwards optional column', async () => {
    mockCallMethod.mockResolvedValue({ id: 'bp-1' });
    await handler('s', { script_uri: 'package:a/b.dart', line: 10, column: 3 });
    expect(mockCallMethod).toHaveBeenCalledWith('addBreakpointWithScriptUri', expect.objectContaining({ column: 3 }));
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { script_uri: 'package:a/b.dart', line: 1 });
    expect(result.isError).toBe(true);
  });
});

// ── flutter_remove_breakpoint ───────────────────────────────────────────────

describe('flutter_remove_breakpoint handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterRemoveBreakpointTool } = require('../../src/tools/flutter-breakpoints');
    registerFlutterRemoveBreakpointTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetBreakpointManagers();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('rejects missing id', async () => {
    const r = await handler('s', {});
    expect(r.isError).toBe(true);
  });

  it('calls removeBreakpoint RPC', async () => {
    mockCallMethod.mockResolvedValue({ type: 'Success' });
    const result = await handler('s', { breakpoint_id: 'breakpoints/7' });
    const body = JSON.parse(result.content[0].text);
    expect(mockCallMethod).toHaveBeenCalledWith('removeBreakpoint', {
      isolateId: 'iso-1',
      breakpointId: 'breakpoints/7',
    });
    expect(body.status).toBe('ok');
  });
});

// ── flutter_resume ──────────────────────────────────────────────────────────

describe('flutter_resume handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterResumeTool } = require('../../src/tools/flutter-breakpoints');
    registerFlutterResumeTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetBreakpointManagers();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockCallMethod.mockResolvedValue({});
  });

  it('resumes without step when mode is "continue" (default)', async () => {
    await handler('s', {});
    expect(mockCallMethod).toHaveBeenCalledWith('resume', { isolateId: 'iso-1' });
  });

  it('passes the correct step for each mode', async () => {
    await handler('s', { mode: 'step_into' });
    await handler('s', { mode: 'step_over' });
    await handler('s', { mode: 'step_out' });

    const calls = mockCallMethod.mock.calls.filter((c) => c[0] === 'resume').map((c) => c[1]);
    expect(calls).toEqual([
      { isolateId: 'iso-1', step: 'Into' },
      { isolateId: 'iso-1', step: 'Over' },
      { isolateId: 'iso-1', step: 'Out' },
    ]);
  });

  it('falls back to "continue" on unknown mode value', async () => {
    const result = await handler('s', { mode: 'warp' });
    expect(result.isError).toBeUndefined();
    expect(mockCallMethod).toHaveBeenCalledWith('resume', { isolateId: 'iso-1' });
  });
});

// ── flutter_get_stack ───────────────────────────────────────────────────────

describe('flutter_get_stack handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterGetStackTool } = require('../../src/tools/flutter-breakpoints');
    registerFlutterGetStackTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('returns summarised frames', async () => {
    mockCallMethod.mockResolvedValue({
      frames: [
        {
          index: 0,
          kind: 'Regular',
          function: { name: 'build' },
          location: { script: { uri: 'package:a/b.dart' }, line: 47 },
          vars: [{ name: 'x' }],
        },
      ],
    });
    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);
    expect(body.frames[0].function).toBe('build');
    expect(body.frames[0].location.line).toBe(47);
    expect(body.frames[0].vars).toEqual(['x']);
  });

  it('forwards limit', async () => {
    mockCallMethod.mockResolvedValue({ frames: [] });
    await handler('s', { limit: 5 });
    expect(mockCallMethod).toHaveBeenCalledWith('getStack', { isolateId: 'iso-1', limit: 5 });
  });

  it('rejects non-positive limit', async () => {
    const result = await handler('s', { limit: 0 });
    expect(result.isError).toBe(true);
  });
});

// ── flutter_wait_for_pause ──────────────────────────────────────────────────

describe('flutter_wait_for_pause handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterWaitForPauseTool } = require('../../src/tools/flutter-breakpoints');
    registerFlutterWaitForPauseTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetBreakpointManagers();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockStreamListen.mockResolvedValue(undefined);
  });

  it('returns timeout when no pause arrives', async () => {
    const result = await handler('s', { timeout_ms: 60, poll_interval_ms: 20 });
    const body = JSON.parse(result.content[0].text);
    expect(body.timeout).toBe(true);
    expect(body.status).toBe('timeout');
  });

  it('returns paused when the Debug listener reports PauseBreakpoint', async () => {
    // Capture the listener the manager registered when we subscribe lazily.
    let capturedListener: ((ev: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((_stream: string, cb: (ev: unknown) => void) => {
      capturedListener = cb;
    });

    // Fire the pause event shortly after we start waiting.
    const p = handler('s', { timeout_ms: 2000, poll_interval_ms: 10 });
    setTimeout(() => {
      capturedListener?.({ kind: 'PauseBreakpoint' });
    }, 30);

    const result = await p;
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('paused');
    expect(body.reason).toBe('PauseBreakpoint');
  });
});

// ── BreakpointManager lifecycle regressions ─────────────────────────────────

describe('BreakpointManager lifecycle', () => {
  // Shared handler for these lifecycle tests.
  let waitHandler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;
  let setBpHandler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../src/tools/flutter-breakpoints');
    mod.registerFlutterWaitForPauseTool(server);
    mod.registerFlutterSetBreakpointTool(server);
    waitHandler = server.registerTool.mock.calls[0][1];
    setBpHandler = server.registerTool.mock.calls[1][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetBreakpointManagers();
    mockIsConnected.mockReturnValue(true);
    mockStreamListen.mockResolvedValue(undefined);
  });

  it('_resetBreakpointManagers calls offEvent on active Debug listeners (P1)', async () => {
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockCallMethod.mockResolvedValue({ id: 'bp/1' });

    // Subscribe by setting a breakpoint (which calls ensureDebugSubscription).
    await setBpHandler('s', { script_uri: 'package:a/b.dart', line: 1 });
    expect(mockOnEvent).toHaveBeenCalledWith('Debug', expect.any(Function));

    // _resetBreakpointManagers must tear down the listener, not just drop state.
    _resetBreakpointManagers();
    expect(mockOffEvent).toHaveBeenCalledWith('Debug', expect.any(Function));
  });

  it('forgetBreakpointManager tears down and re-subscribes cleanly on next call', async () => {
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockCallMethod.mockResolvedValue({ id: 'bp/1' });

    await setBpHandler('s', { script_uri: 'package:a/b.dart', line: 1 });
    const offCallsBefore = mockOffEvent.mock.calls.length;

    forgetBreakpointManager('test-device-id');
    expect(mockOffEvent.mock.calls.length).toBeGreaterThan(offCallsBefore);

    // A follow-up wait should cleanly re-subscribe — no "already subscribed" short-circuit.
    const waitPromise = waitHandler('s', { timeout_ms: 30, poll_interval_ms: 10 });
    const result = await waitPromise;
    expect(JSON.parse(result.content[0].text).status).toBe('timeout');
    // streamListen called at least twice: original subscribe + post-forget re-subscribe.
    expect(mockStreamListen.mock.calls.filter((c) => c[0] === 'Debug').length).toBeGreaterThanOrEqual(2);
  });

  it('auto-resubscribes when mainIsolateId changes (reconnect / hot restart)', async () => {
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockCallMethod.mockResolvedValue({ id: 'bp/1' });

    await setBpHandler('s', { script_uri: 'package:a/b.dart', line: 1 });
    const firstOnEventCount = mockOnEvent.mock.calls.filter((c) => c[0] === 'Debug').length;

    // Simulate a reconnect: VM client now reports a different isolate id.
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-2' });

    await setBpHandler('s', { script_uri: 'package:a/b.dart', line: 2 });

    // onEvent must have been called a second time with the new listener.
    const newOnEventCount = mockOnEvent.mock.calls.filter((c) => c[0] === 'Debug').length;
    expect(newOnEventCount).toBe(firstOnEventCount + 1);
    // offEvent should have been called to detach the stale listener.
    expect(mockOffEvent).toHaveBeenCalledWith('Debug', expect.any(Function));
  });
});
