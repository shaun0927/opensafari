/**
 * Unit tests for native app interaction tools:
 *   app_tap, app_double_tap, app_type_text, app_swipe_native, app_key_input
 *
 * These tools bypass WebKit and talk directly to the Simulator via simctl,
 * so we mock SimctlExecutor and the session manager rather than a WebKit client.
 */

// Mock getWebKitClient before importing tool modules that depend on it
jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppTapTool } from '../../src/tools/app-tap';
import { registerAppDoubleTapTool } from '../../src/tools/app-double-tap';
import { registerAppTypeTextTool } from '../../src/tools/app-type';
import { registerAppSwipeNativeTool, calculateEndpoint } from '../../src/tools/app-swipe';
import { registerAppKeyInputTool } from '../../src/tools/app-key-input';
import { KEY_MAP } from '../../src/tools/native-input-utils';

// ── Mocks ──────────────────────────────────────────────────────────────────

const execMock = jest.fn().mockResolvedValue('');
const mockDumpTree = jest.fn();

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: execMock,
  })),
  SimctlError: class SimctlError extends Error {
    args: string[];
    exitCode?: number;
    constructor(message: string, args: string[], exitCode?: number) {
      super(message);
      this.name = 'SimctlError';
      this.args = args;
      this.exitCode = exitCode;
    }
  },
  SimulatorStateCache: class SimulatorStateCache {
    private entries = new Map<string, { udid: string; state: string; cachedAt: number }>();
    private ttlMs: number;
    constructor(ttlMs: number) { this.ttlMs = ttlMs; }
    get(udid: string) {
      const entry = this.entries.get(udid);
      if (!entry) return undefined;
      if (Date.now() - entry.cachedAt > this.ttlMs) { this.entries.delete(udid); return undefined; }
      return entry;
    }
    set(udid: string, state: string) { this.entries.set(udid, { udid, state, cachedAt: Date.now() }); }
    invalidate(udid: string) { this.entries.delete(udid); }
    invalidateAll() { this.entries.clear(); }
  },
  hasBootstatus: jest.fn().mockResolvedValue(false),
  resetBootstatusCapabilityForTests: jest.fn(),
}));

// Mock getInputBackend to skip detection probe and delegate to mocked SimctlExecutor
jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SimctlExecutor } = require('../../src/simulator/simctl');
    const simctl = new SimctlExecutor();
    return {
      kind: 'simctl' as const,
      tap: async (deviceId: string, x: number, y: number, duration?: number) => {
        if (duration && duration > 0) {
          await simctl.exec(['io', deviceId, 'input', 'press', String(x), String(y), String(duration)]);
        } else {
          await simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
        }
      },
      swipe: async (deviceId: string, sx: number, sy: number, ex: number, ey: number, dur?: number) => {
        try {
          await simctl.exec(['io', deviceId, 'input', 'swipe', String(sx), String(sy), String(ex), String(ey)]);
        } catch {
          await simctl.exec(['io', deviceId, 'input', 'drag', String(sx), String(sy), String(ex), String(ey), String(dur ?? 0.5)]);
        }
      },
      typeText: async (deviceId: string, text: string) => {
        await simctl.exec(['io', deviceId, 'input', 'text', text]);
      },
      keypress: async (deviceId: string, keyCode: string) => {
        await simctl.exec(['io', deviceId, 'input', 'keypress', keyCode]);
      },
      sendKey: async (deviceId: string, keyName: string) => {
        await simctl.exec(['io', deviceId, 'sendkey', keyName]);
      },
    };
  }),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'MOCK-DEVICE-UDID',
  }),
}));

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: mockDumpTree,
  }),
}));

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(10),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function makeTree(label: string) {
  return {
    role: 'AXWindow',
    label: 'Test App',
    traits: [],
    frame: { x: 0, y: 0, width: 375, height: 812 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXStaticText',
        label,
        traits: ['text'],
        frame: { x: 0, y: 0, width: 200, height: 44 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0',
      },
    ],
  };
}

// ── Test suites ────────────────────────────────────────────────────────────

describe('app_tap tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppTapTool(server);
  });

  beforeEach(() => {
    execMock.mockClear();
    mockDumpTree.mockReset();
    mockDumpTree
      .mockResolvedValueOnce(makeTree('before'))
      .mockResolvedValue(makeTree('after'));
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_tap');
  });

  test('taps at given coordinates', async () => {
    jest.useFakeTimers();
    const handler = server.getToolHandler('app_tap')!;
    const promise = handler('s', { x: 100, y: 200 });
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    const body = parseResult(result as any);
    expect(body.status).toBe('tapped');
    expect(body.x).toBe(100);
    expect(body.y).toBe(200);
    expect(body.backend).toBe('simctl');
    expect(body.verified).toBe(true);
    expect(body.effect).toBe('subtree_changed');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'MOCK-DEVICE-UDID' });
    expect(execMock).toHaveBeenCalledWith(
      ['io', 'MOCK-DEVICE-UDID', 'input', 'tap', '100', '200'],
    );
  });

  test('long press with duration', async () => {
    jest.useFakeTimers();
    const handler = server.getToolHandler('app_tap')!;
    const promise = handler('s', { x: 50, y: 60, duration: 1.5 });
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    const body = parseResult(result as any);
    expect(body.duration).toBe(1.5);
    expect(execMock).toHaveBeenCalledWith(
      ['io', 'MOCK-DEVICE-UDID', 'input', 'press', '50', '60', '1.5'],
    );
  });

  test('rejects non-finite coordinates', async () => {
    // Coordinate validation happens before the poll loop — no timers needed.
    const handler = server.getToolHandler('app_tap')!;
    const result = await handler('s', { x: NaN, y: 100 });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toContain('finite numbers');
  });

  test('uses explicit deviceId when provided', async () => {
    jest.useFakeTimers();
    const handler = server.getToolHandler('app_tap')!;
    const promise = handler('s', { x: 10, y: 20, deviceId: 'CUSTOM-UDID' });
    await jest.runAllTimersAsync();
    await promise;
    jest.useRealTimers();

    expect(execMock).toHaveBeenCalledWith(
      ['io', 'CUSTOM-UDID', 'input', 'tap', '10', '20'],
    );
  });

  test('returns error on simctl failure', async () => {
    // Simctl throws before reaching the poll loop — no timers needed.
    execMock.mockRejectedValueOnce(new Error('simctl io failed'));
    const handler = server.getToolHandler('app_tap')!;
    const result = await handler('s', { x: 10, y: 20 });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toContain('simctl io failed');
  });

  test('returns TAP_NO_EFFECT when the AX tree does not change after the tap', async () => {
    jest.useFakeTimers();
    mockDumpTree.mockReset();
    // Pre-tap snapshot + all poll samples return the same tree — poll window times out.
    mockDumpTree.mockResolvedValue(makeTree('same'));

    const handler = server.getToolHandler('app_tap')!;
    const promise = handler('s', { x: 10, y: 20 });
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toBe('TAP_NO_EFFECT');
    expect(body.verified).toBe(false);
    expect(body.effect).toBe('no_observable_change');
  });
});

describe('app_double_tap tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppDoubleTapTool(server);
  });

  beforeEach(() => {
    execMock.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_double_tap');
  });

  test('sends two taps', async () => {
    const handler = server.getToolHandler('app_double_tap')!;
    const result = await handler('s', { x: 100, y: 200 });
    const body = parseResult(result as any);
    expect(body.status).toBe('double_tapped');
    expect(body.backend).toBe('simctl');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'MOCK-DEVICE-UDID' });
    // Two exec calls for the two taps
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      ['io', 'MOCK-DEVICE-UDID', 'input', 'tap', '100', '200'],
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      ['io', 'MOCK-DEVICE-UDID', 'input', 'tap', '100', '200'],
    );
  });

  test('rejects non-finite coordinates', async () => {
    const handler = server.getToolHandler('app_double_tap')!;
    const result = await handler('s', { x: Infinity, y: 0 });
    expect((result as any).isError).toBe(true);
  });
});

describe('app_type_text tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppTypeTextTool(server);
  });

  beforeEach(() => {
    execMock.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_type_text');
  });

  test('types provided text', async () => {
    const handler = server.getToolHandler('app_type_text')!;
    const result = await handler('s', { text: 'hello world' });
    const body = parseResult(result as any);
    expect(body.status).toBe('typed');
    expect(body.length).toBe(11);
    expect(body.backend).toBe('simctl');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'MOCK-DEVICE-UDID' });
    expect(execMock).toHaveBeenCalledWith(
      ['io', 'MOCK-DEVICE-UDID', 'input', 'text', 'hello world'],
    );
  });

  test('rejects empty text', async () => {
    const handler = server.getToolHandler('app_type_text')!;
    const result = await handler('s', { text: '' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toContain('non-empty string');
  });

  test('returns error on simctl failure', async () => {
    execMock.mockRejectedValueOnce(new Error('keyboard unavailable'));
    const handler = server.getToolHandler('app_type_text')!;
    const result = await handler('s', { text: 'test' });
    expect((result as any).isError).toBe(true);
  });
});

describe('app_swipe_native tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppSwipeNativeTool(server);
  });

  beforeEach(() => {
    execMock.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_swipe_native');
  });

  test('swipes up', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'up', startX: 200, startY: 500, distance: 300 });
    const body = parseResult(result as any);
    expect(body.status).toBe('swiped');
    expect(body.direction).toBe('up');
    expect(body.to.y).toBe(200); // 500 - 300
    expect(body.backend).toBe('simctl');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'MOCK-DEVICE-UDID' });
  });

  test('swipes down', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'down', startX: 200, startY: 100, distance: 300 });
    const body = parseResult(result as any);
    expect(body.to.y).toBe(400); // 100 + 300
  });

  test('swipes left', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'left', startX: 300, startY: 200, distance: 200 });
    const body = parseResult(result as any);
    expect(body.to.x).toBe(100); // 300 - 200
  });

  test('swipes right', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'right', startX: 100, startY: 200, distance: 200 });
    const body = parseResult(result as any);
    expect(body.to.x).toBe(300); // 100 + 200
  });

  test('uses defaults when start coordinates omitted', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'up' });
    const body = parseResult(result as any);
    expect(body.from.x).toBe(195);
    expect(body.from.y).toBe(422);
    expect(body.distance).toBe(300);
  });

  test('falls back to drag on swipe failure', async () => {
    execMock
      .mockRejectedValueOnce(new Error('swipe not supported'))
      .mockResolvedValueOnce('');
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'up', startX: 200, startY: 500, distance: 100 });
    const body = parseResult(result as any);
    expect(body.status).toBe('swiped');
    // Second call should be drag
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1][0]).toContain('drag');
  });

  test('rejects invalid direction', async () => {
    const handler = server.getToolHandler('app_swipe_native')!;
    const result = await handler('s', { direction: 'diagonal' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toContain('Invalid direction');
  });
});

describe('app_key_input tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppKeyInputTool(server);
  });

  beforeEach(() => {
    execMock.mockClear();
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_key_input');
  });

  test('presses return key', async () => {
    const handler = server.getToolHandler('app_key_input')!;
    const result = await handler('s', { key: 'return' });
    const body = parseResult(result as any);
    expect(body.status).toBe('key_pressed');
    expect(body.key).toBe('return');
    expect(body.keyCode).toBe('40');
    expect(body.backend).toBe('simctl');
    expect(body._meta).toEqual({ backendKind: 'simctl', headless: true, deviceId: 'MOCK-DEVICE-UDID' });
    expect(execMock).toHaveBeenCalledWith(
      ['io', 'MOCK-DEVICE-UDID', 'input', 'keypress', '40'],
    );
  });

  test('is case-insensitive', async () => {
    const handler = server.getToolHandler('app_key_input')!;
    const result = await handler('s', { key: 'ESCAPE' });
    const body = parseResult(result as any);
    expect(body.key).toBe('escape');
    expect(body.keyCode).toBe('41');
  });

  test('rejects unknown key', async () => {
    const handler = server.getToolHandler('app_key_input')!;
    const result = await handler('s', { key: 'f13' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result as any);
    expect(body.error).toContain('Unknown key');
    expect(body.error).toContain('Supported keys');
  });

  test('all KEY_MAP entries are strings', () => {
    for (const [key, code] of Object.entries(KEY_MAP)) {
      expect(typeof key).toBe('string');
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

describe('calculateEndpoint', () => {
  test('up subtracts from Y', () => {
    const { endX, endY } = calculateEndpoint(100, 500, 'up', 200);
    expect(endX).toBe(100);
    expect(endY).toBe(300);
  });

  test('down adds to Y', () => {
    const { endX, endY } = calculateEndpoint(100, 100, 'down', 200);
    expect(endX).toBe(100);
    expect(endY).toBe(300);
  });

  test('left subtracts from X', () => {
    const { endX, endY } = calculateEndpoint(300, 100, 'left', 150);
    expect(endX).toBe(150);
    expect(endY).toBe(100);
  });

  test('right adds to X', () => {
    const { endX, endY } = calculateEndpoint(100, 100, 'right', 150);
    expect(endX).toBe(250);
    expect(endY).toBe(100);
  });
});

describe('resolveDeviceId', () => {
  test('falls back to active device from session manager', async () => {
    // Already mocked to return 'MOCK-DEVICE-UDID'
    const server = new MCPServer();
    registerAppTapTool(server);
    const handler = server.getToolHandler('app_tap')!;
    const result = await handler('s', { x: 0, y: 0 });
    const body = parseResult(result as any);
    expect(body.deviceId).toBe('MOCK-DEVICE-UDID');
  });
});
