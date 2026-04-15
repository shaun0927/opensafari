/**
 * Unit tests for NativeInputBackend abstraction.
 *
 * Tests both SimctlInputBackend and AppleScriptInputBackend,
 * plus auto-detection and caching logic.
 */

import {
  SimctlInputBackend,
  AppleScriptInputBackend,
  WebKitInputBackend,
  getInputBackend,
  resetInputBackend,
  HeadlessInputUnavailableError,
  OPENSAFARI_ALLOW_FOCUS_INPUT_ENV,
  HID_TO_APPLESCRIPT,
  SENDKEY_TO_APPLESCRIPT,
  HID_TO_WEBKIT_KEY,
  SENDKEY_TO_WEBKIT_KEY,
} from '../../src/tools/native-input-backend';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Use var for hoisting compatibility with jest.mock
/* eslint-disable no-var */
var execMock = jest.fn().mockResolvedValue('');
var execFileMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
/* eslint-enable no-var */

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
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Return a lazy wrapper so execFileMock is resolved at call time, not import time
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execFileMock(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const DEVICE = 'TEST-DEVICE-UDID';

// ── SimctlInputBackend ─────────────────────────────────────────────────────

describe('SimctlInputBackend', () => {
  let backend: SimctlInputBackend;

  beforeEach(() => {
    execMock.mockClear();
    backend = new SimctlInputBackend({ exec: execMock } as any);
  });

  test('exposes kind="simctl" for observability', () => {
    expect(backend.kind).toBe('simctl');
  });

  test('tap sends simctl io input tap', async () => {
    await backend.tap(DEVICE, 100, 200);
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'tap', '100', '200'],
    );
  });

  test('tap with duration sends simctl io input press', async () => {
    await backend.tap(DEVICE, 150, 300, 2);
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'press', '150', '300', '2'],
    );
  });

  test('tap with zero duration sends normal tap', async () => {
    await backend.tap(DEVICE, 50, 60, 0);
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'tap', '50', '60'],
    );
  });

  test('swipe sends simctl io input swipe', async () => {
    await backend.swipe(DEVICE, 100, 600, 100, 200);
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'swipe', '100', '600', '100', '200'],
    );
  });

  test('swipe falls back to drag on failure', async () => {
    execMock
      .mockRejectedValueOnce(new Error('swipe not supported'))
      .mockResolvedValueOnce('');
    await backend.swipe(DEVICE, 100, 600, 100, 200, 0.8);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenLastCalledWith(
      ['io', DEVICE, 'input', 'drag', '100', '600', '100', '200', '0.8'],
    );
  });

  test('swipe drag fallback uses default duration', async () => {
    execMock
      .mockRejectedValueOnce(new Error('swipe not supported'))
      .mockResolvedValueOnce('');
    await backend.swipe(DEVICE, 0, 0, 100, 100);
    expect(execMock).toHaveBeenLastCalledWith(
      ['io', DEVICE, 'input', 'drag', '0', '0', '100', '100', '0.5'],
    );
  });

  test('typeText sends simctl io input text', async () => {
    await backend.typeText(DEVICE, 'hello world');
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'text', 'hello world'],
    );
  });

  test('keypress sends simctl io input keypress', async () => {
    await backend.keypress(DEVICE, '40');
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'keypress', '40'],
    );
  });

  test('sendKey sends simctl io sendkey', async () => {
    await backend.sendKey(DEVICE, 'Return');
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'sendkey', 'Return'],
    );
  });
});

// ── AppleScriptInputBackend ────────────────────────────────────────────────

describe('AppleScriptInputBackend', () => {
  let backend: AppleScriptInputBackend;

  beforeEach(() => {
    execFileMock.mockClear();
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    backend = new AppleScriptInputBackend();
  });

  test('exposes kind="applescript" for observability', () => {
    expect(backend.kind).toBe('applescript');
  });

  test('tap activates Simulator and calls osascript click', async () => {
    // First call: activate Simulator
    // Second call: get window + child UI element positions
    // Third call: click at coordinates
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // activate
      .mockResolvedValueOnce({ stdout: '100,200|100,230', stderr: '' })    // AX origin query
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                   // click

    await backend.tap(DEVICE, 50, 100);

    // Third call should be the click at translated coordinates
    // Child UI element (content origin) at (100, 230)
    // iOS (50, 100) → screen (150, 330)
    const clickCall = execFileMock.mock.calls[2];
    expect(clickCall[0]).toBe('osascript');
    expect(clickCall[1]).toContain(
      'tell application "System Events" to click at {150, 330}',
    );
  });

  test('tap with duration uses Swift CGEvent for long press', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                  // activate
      .mockResolvedValueOnce({ stdout: '0,0|0,28', stderr: '' })         // AX origin query
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                 // swift CGEvent

    await backend.tap(DEVICE, 200, 400, 1.5);

    const swiftCall = execFileMock.mock.calls[2];
    expect(swiftCall[0]).toBe('swift');
    expect(swiftCall[1][1]).toContain('leftMouseDown');
    expect(swiftCall[1][1]).toContain('1.5');
  });

  test('typeText activates Simulator and sends keystroke', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // activate
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // keystroke

    await backend.typeText(DEVICE, 'hello');

    const keystrokeCall = execFileMock.mock.calls[1];
    expect(keystrokeCall[0]).toBe('osascript');
    expect(keystrokeCall[1]).toContain(
      'tell application "System Events" to keystroke "hello"',
    );
  });

  test('typeText escapes special characters', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await backend.typeText(DEVICE, 'say "hi" \\ there');

    const keystrokeCall = execFileMock.mock.calls[1];
    expect(keystrokeCall[1]).toContain(
      'tell application "System Events" to keystroke "say \\"hi\\" \\\\ there"',
    );
  });

  test('keypress maps HID code to AppleScript key code', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // activate
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // key code

    await backend.keypress(DEVICE, '40'); // Return = HID 40 → AS 36

    const keyCall = execFileMock.mock.calls[1];
    expect(keyCall[0]).toBe('osascript');
    expect(keyCall[1]).toContain(
      'tell application "System Events" to key code 36',
    );
  });

  test('keypress throws for unknown HID code', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' }); // activate
    await expect(backend.keypress(DEVICE, '999')).rejects.toThrow(
      'Unknown HID key code "999"',
    );
  });

  test('sendKey maps key name to AppleScript key code', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await backend.sendKey(DEVICE, 'Escape');

    const keyCall = execFileMock.mock.calls[1];
    expect(keyCall[1]).toContain(
      'tell application "System Events" to key code 53',
    );
  });

  test('sendKey throws for unknown key name', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await expect(backend.sendKey(DEVICE, 'Unknown')).rejects.toThrow(
      'Unknown key name "Unknown"',
    );
  });

  test('swipe activates Simulator and uses Swift CGEvent drag', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                   // activate
      .mockResolvedValueOnce({ stdout: '50,100|50,128', stderr: '' })     // AX origin query
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                  // swift

    await backend.swipe(DEVICE, 200, 600, 200, 200, 0.5);

    const swiftCall = execFileMock.mock.calls[2];
    expect(swiftCall[0]).toBe('swift');
    const script = swiftCall[1][1];
    expect(script).toContain('leftMouseDown');
    expect(script).toContain('leftMouseDragged');
    expect(script).toContain('leftMouseUp');
  });

  // ── getSimulatorContentOrigin (dynamic AX measurement) ────────────────────

  test('getSimulatorContentOrigin returns child UI element position', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '300,150|300,178\n', stderr: '' });

    const origin = await backend.getSimulatorContentOrigin(DEVICE);
    // Uses the child element position directly — no hardcoded offset
    expect(origin).toEqual({ x: 300, y: 178 });
  });

  test('getSimulatorContentOrigin falls back to window position on malformed output', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Malformed: missing pipe separator → triggers fallback path
    execFileMock
      .mockResolvedValueOnce({ stdout: 'malformed-output', stderr: '' })  // AX query fails parse
      .mockResolvedValueOnce({ stdout: '100,200', stderr: '' });           // fallback window query

    const origin = await backend.getSimulatorContentOrigin(DEVICE);
    expect(origin).toEqual({ x: 100, y: 200 });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('falling back to window position');
    consoleErrorSpy.mockRestore();
  });

  test('getSimulatorContentOrigin emits console.error warning only once per device', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    execFileMock
      .mockResolvedValueOnce({ stdout: 'bad', stderr: '' })   // first call — fails
      .mockResolvedValueOnce({ stdout: '10,20', stderr: '' }) // fallback window pos
      .mockResolvedValueOnce({ stdout: 'bad', stderr: '' });  // second call (refresh) — fails again

    // First call — warns
    await backend.getSimulatorContentOrigin(DEVICE);
    // Second call with refresh=true — same device, should NOT warn again
    await backend.getSimulatorContentOrigin(DEVICE, { refresh: true });

    const warningCalls = consoleErrorSpy.mock.calls.filter((args) =>
      String(args[0]).includes('falling back to window position'),
    );
    expect(warningCalls).toHaveLength(1);
    consoleErrorSpy.mockRestore();
  });

  test('getSimulatorContentOrigin falls back to window position when AppleScript throws', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    execFileMock
      .mockRejectedValueOnce(new Error('osascript: timed out'))  // AX query throws
      .mockResolvedValueOnce({ stdout: '50,60', stderr: '' });    // fallback window query

    const origin = await backend.getSimulatorContentOrigin(DEVICE);
    expect(origin).toEqual({ x: 50, y: 60 });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  test('getSimulatorContentOrigin cache hit returns same value without re-invoking osascript', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '10,20|10,48', stderr: '' });

    const first = await backend.getSimulatorContentOrigin(DEVICE);
    const second = await backend.getSimulatorContentOrigin(DEVICE);

    expect(first).toEqual({ x: 10, y: 48 });
    expect(second).toEqual({ x: 10, y: 48 });
    // osascript should only have been called once (via execFileMock)
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test('getSimulatorContentOrigin refresh:true re-invokes osascript', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '10,20|10,48', stderr: '' })   // first call
      .mockResolvedValueOnce({ stdout: '30,40|30,68', stderr: '' });  // after refresh

    await backend.getSimulatorContentOrigin(DEVICE);
    const refreshed = await backend.getSimulatorContentOrigin(DEVICE, { refresh: true });

    expect(refreshed).toEqual({ x: 30, y: 68 });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('getSimulatorContentOrigin uses independent cache entries per deviceId', async () => {
    const DEVICE_B = 'DEVICE-B-UDID';
    execFileMock
      .mockResolvedValueOnce({ stdout: '10,20|10,48', stderr: '' })   // device A
      .mockResolvedValueOnce({ stdout: '50,60|50,88', stderr: '' });  // device B

    const originA = await backend.getSimulatorContentOrigin(DEVICE);
    const originB = await backend.getSimulatorContentOrigin(DEVICE_B);

    expect(originA).toEqual({ x: 10, y: 48 });
    expect(originB).toEqual({ x: 50, y: 88 });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Cache hits should not call osascript again
    await backend.getSimulatorContentOrigin(DEVICE);
    await backend.getSimulatorContentOrigin(DEVICE_B);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('tap translates iOS-point coordinates to absolute screen using dynamic origin', async () => {
    // Simulate AX returning window at (200,300) and child (content) at (200,330)
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // activate
      .mockResolvedValueOnce({ stdout: '200,300|200,330', stderr: '' })    // AX origin
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                   // click

    await backend.tap(DEVICE, 75, 150);

    // content origin (200, 330) + iOS (75, 150) = screen (275, 480)
    const clickCall = execFileMock.mock.calls[2];
    expect(clickCall[0]).toBe('osascript');
    expect(clickCall[1]).toContain(
      'tell application "System Events" to click at {275, 480}',
    );
  });
});

// ── Key mappings ───────────────────────────────────────────────────────────

describe('Key mappings', () => {
  test('HID_TO_APPLESCRIPT covers standard keys', () => {
    expect(HID_TO_APPLESCRIPT['40']).toBe(36);  // Return
    expect(HID_TO_APPLESCRIPT['41']).toBe(53);  // Escape
    expect(HID_TO_APPLESCRIPT['42']).toBe(51);  // Backspace
    expect(HID_TO_APPLESCRIPT['43']).toBe(48);  // Tab
    expect(HID_TO_APPLESCRIPT['44']).toBe(49);  // Space
    expect(HID_TO_APPLESCRIPT['79']).toBe(124); // Right
    expect(HID_TO_APPLESCRIPT['80']).toBe(123); // Left
    expect(HID_TO_APPLESCRIPT['81']).toBe(125); // Down
    expect(HID_TO_APPLESCRIPT['82']).toBe(126); // Up
  });

  test('SENDKEY_TO_APPLESCRIPT covers named keys', () => {
    expect(SENDKEY_TO_APPLESCRIPT.Return).toBe(36);
    expect(SENDKEY_TO_APPLESCRIPT.Escape).toBe(53);
    expect(SENDKEY_TO_APPLESCRIPT.Tab).toBe(48);
    expect(SENDKEY_TO_APPLESCRIPT.Space).toBe(49);
    expect(SENDKEY_TO_APPLESCRIPT.Delete).toBe(51);
  });
});

// ── WebKitInputBackend ────────────────────────────────────────────────────

describe('WebKitInputBackend', () => {
  let backend: WebKitInputBackend;
  let mockClient: {
    click: jest.Mock;
    scroll: jest.Mock;
    swipe: jest.Mock;
    evaluate: jest.Mock;
    press: jest.Mock;
    isConnected: jest.Mock;
  };

  beforeEach(() => {
    mockClient = {
      click: jest.fn().mockResolvedValue(undefined),
      scroll: jest.fn().mockResolvedValue(undefined),
      swipe: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    };
    backend = new WebKitInputBackend(mockClient as any);
  });

  test('exposes kind="webkit" for observability', () => {
    expect(backend.kind).toBe('webkit');
  });

  test('tap delegates to client.click for normal tap', async () => {
    await backend.tap(DEVICE, 100, 200);
    expect(mockClient.click).toHaveBeenCalledWith({ x: 100, y: 200 });
    expect(mockClient.evaluate).not.toHaveBeenCalled();
  });

  test('tap uses evaluate for long press', async () => {
    await backend.tap(DEVICE, 100, 200, 1.5);
    expect(mockClient.evaluate).toHaveBeenCalledTimes(1);
    const js = mockClient.evaluate.mock.calls[0][0] as string;
    expect(js).toContain('touchstart');
    expect(js).toContain('touchend');
    expect(js).toContain('1500'); // 1.5 * 1000
    expect(mockClient.click).not.toHaveBeenCalled();
  });

  test('tap with zero duration delegates to client.click', async () => {
    await backend.tap(DEVICE, 50, 60, 0);
    expect(mockClient.click).toHaveBeenCalledWith({ x: 50, y: 60 });
  });

  test('swipe calls evaluate with scrollBy and touch events', async () => {
    await backend.swipe(DEVICE, 200, 600, 200, 200, 0.5);
    expect(mockClient.evaluate).toHaveBeenCalledTimes(1);
    const js = mockClient.evaluate.mock.calls[0][0] as string;
    expect(js).toContain('window.scrollBy');
    expect(js).toContain('touchstart');
    expect(js).toContain('touchmove');
    expect(js).toContain('touchend');
  });

  test('swipe calculates correct scroll delta', async () => {
    // Swipe up: startY(600) > endY(200) → scrollY = 400 (scroll down)
    await backend.swipe(DEVICE, 200, 600, 200, 200);
    const js = mockClient.evaluate.mock.calls[0][0] as string;
    // scrollX = 200 - 200 = 0, scrollY = 600 - 200 = 400
    expect(js).toContain('0, 400');
  });

  test('typeText calls evaluate with active element targeting', async () => {
    await backend.typeText(DEVICE, 'hello');
    expect(mockClient.evaluate).toHaveBeenCalledTimes(1);
    const js = mockClient.evaluate.mock.calls[0][0] as string;
    expect(js).toContain('document.activeElement');
    expect(js).toContain('"hello"');
    expect(js).toContain('input');
    expect(js).toContain('change');
  });

  test('typeText escapes special characters in text', async () => {
    await backend.typeText(DEVICE, 'say "hi" \\ there');
    const js = mockClient.evaluate.mock.calls[0][0] as string;
    expect(js).toContain('"say \\"hi\\" \\\\ there"');
  });

  test('keypress maps HID code to WebKit key and calls press', async () => {
    await backend.keypress(DEVICE, '40'); // Enter
    expect(mockClient.press).toHaveBeenCalledWith('Enter');
  });

  test('keypress throws for unknown HID code', async () => {
    await expect(backend.keypress(DEVICE, '999')).rejects.toThrow(
      'Unknown HID key code "999"',
    );
  });

  test('sendKey maps named key and calls press', async () => {
    await backend.sendKey(DEVICE, 'Return');
    expect(mockClient.press).toHaveBeenCalledWith('Enter');
  });

  test('sendKey passes through unmapped key names', async () => {
    await backend.sendKey(DEVICE, 'ArrowDown');
    expect(mockClient.press).toHaveBeenCalledWith('ArrowDown');
  });
});

// ── WebKit key mappings ──────────────────────────────────────────────────

describe('WebKit key mappings', () => {
  test('HID_TO_WEBKIT_KEY covers standard keys', () => {
    expect(HID_TO_WEBKIT_KEY['40']).toBe('Enter');
    expect(HID_TO_WEBKIT_KEY['41']).toBe('Escape');
    expect(HID_TO_WEBKIT_KEY['42']).toBe('Backspace');
    expect(HID_TO_WEBKIT_KEY['43']).toBe('Tab');
    expect(HID_TO_WEBKIT_KEY['44']).toBe('Space');
    expect(HID_TO_WEBKIT_KEY['79']).toBe('ArrowRight');
    expect(HID_TO_WEBKIT_KEY['80']).toBe('ArrowLeft');
    expect(HID_TO_WEBKIT_KEY['81']).toBe('ArrowDown');
    expect(HID_TO_WEBKIT_KEY['82']).toBe('ArrowUp');
  });

  test('SENDKEY_TO_WEBKIT_KEY covers named keys', () => {
    expect(SENDKEY_TO_WEBKIT_KEY.Return).toBe('Enter');
    expect(SENDKEY_TO_WEBKIT_KEY.Escape).toBe('Escape');
    expect(SENDKEY_TO_WEBKIT_KEY.Tab).toBe('Tab');
    expect(SENDKEY_TO_WEBKIT_KEY.Space).toBe('Space');
    expect(SENDKEY_TO_WEBKIT_KEY.Delete).toBe('Backspace');
  });
});

// ── Auto-detection (3-tier fallback) ─────────────────────────────────────

describe('getInputBackend', () => {
  const originalEnv = process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV];

  beforeEach(() => {
    execMock.mockClear();
    resetInputBackend();
    delete process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV];
    } else {
      process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = originalEnv;
    }
  });

  test('returns SimctlInputBackend when simctl io input succeeds', async () => {
    execMock.mockResolvedValueOnce('');
    const backend = await getInputBackend(DEVICE);
    expect(backend).toBeInstanceOf(SimctlInputBackend);
    expect(backend.kind).toBe('simctl');
    expect(execMock).toHaveBeenCalledWith(
      ['io', DEVICE, 'input', 'tap', '0', '0'],
      { timeout: 5000 },
    );
  });

  test('returns SimctlInputBackend even when webkitClient is provided (tier 1 wins)', async () => {
    execMock.mockResolvedValueOnce('');
    const mockClient = { isConnected: () => true } as any;
    const backend = await getInputBackend(DEVICE, mockClient);
    expect(backend).toBeInstanceOf(SimctlInputBackend);
    expect(backend.kind).toBe('simctl');
  });

  test('returns WebKitInputBackend when simctl fails but webkitClient is connected', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const mockClient = { isConnected: () => true } as any;
    const backend = await getInputBackend(DEVICE, mockClient);
    expect(backend).toBeInstanceOf(WebKitInputBackend);
    expect(backend.kind).toBe('webkit');
  });

  // ── Default-deny behavior (issue #405) ──────────────────────────────────

  test('throws HeadlessInputUnavailableError when simctl fails and no webkitClient', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    await expect(getInputBackend(DEVICE)).rejects.toBeInstanceOf(
      HeadlessInputUnavailableError,
    );
  });

  test('throws HeadlessInputUnavailableError when webkitClient is null', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    await expect(getInputBackend(DEVICE, null)).rejects.toBeInstanceOf(
      HeadlessInputUnavailableError,
    );
  });

  test('throws HeadlessInputUnavailableError reason=no-webkit when no client is supplied', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    try {
      await getInputBackend(DEVICE);
      fail('expected HeadlessInputUnavailableError');
    } catch (err) {
      expect(err).toBeInstanceOf(HeadlessInputUnavailableError);
      const hErr = err as HeadlessInputUnavailableError;
      expect(hErr.reason).toBe('no-webkit');
      expect(hErr.deviceId).toBe(DEVICE);
    }
  });

  test('thrown error message includes both remediation options', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    try {
      await getInputBackend(DEVICE);
      fail('expected HeadlessInputUnavailableError');
    } catch (err) {
      const hErr = err as HeadlessInputUnavailableError;
      expect(hErr.message).toContain("set_active_context({ context: 'safari' })");
      expect(hErr.message).toContain('OPENSAFARI_ALLOW_FOCUS_INPUT=1');
      expect(hErr.remediation).toHaveLength(2);
    }
  });

  // ── WebKit reconnect retry (issue #405) ─────────────────────────────────

  test('attempts a one-shot WebKit reconnect when client is disconnected', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const isConnected = jest
      .fn()
      .mockReturnValueOnce(false) // initial check
      .mockReturnValueOnce(true); // after reconnect succeeds
    const connect = jest.fn().mockResolvedValue(undefined);
    const mockClient = { isConnected, connect } as any;

    const backend = await getInputBackend(DEVICE, mockClient);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(WebKitInputBackend);
  });

  test('falls through to strict guard when WebKit reconnect fails', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const isConnected = jest.fn().mockReturnValue(false);
    const connect = jest.fn().mockRejectedValue(new Error('proxy dead'));
    const mockClient = { isConnected, connect } as any;

    await expect(getInputBackend(DEVICE, mockClient)).rejects.toBeInstanceOf(
      HeadlessInputUnavailableError,
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('reconnect error reason is webkit-disconnected', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const mockClient = {
      isConnected: jest.fn().mockReturnValue(false),
      connect: jest.fn().mockRejectedValue(new Error('proxy dead')),
    } as any;
    try {
      await getInputBackend(DEVICE, mockClient);
      fail('expected HeadlessInputUnavailableError');
    } catch (err) {
      expect((err as HeadlessInputUnavailableError).reason).toBe(
        'webkit-disconnected',
      );
    }
  });

  // ── Env var opt-in (issue #405) ─────────────────────────────────────────

  test('returns AppleScriptInputBackend when OPENSAFARI_ALLOW_FOCUS_INPUT=1', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = '1';
    const backend = await getInputBackend(DEVICE);
    expect(backend).toBeInstanceOf(AppleScriptInputBackend);
    expect(backend.kind).toBe('applescript');
  });

  test('returns AppleScriptInputBackend when OPENSAFARI_ALLOW_FOCUS_INPUT=true', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = 'true';
    const backend = await getInputBackend(DEVICE);
    expect(backend).toBeInstanceOf(AppleScriptInputBackend);
    expect(backend.kind).toBe('applescript');
  });

  test('ignores opt-in values other than "1" or "true"', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = 'yes';
    await expect(getInputBackend(DEVICE)).rejects.toBeInstanceOf(
      HeadlessInputUnavailableError,
    );
  });

  test('opt-in also works when webkitClient is null', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = '1';
    const backend = await getInputBackend(DEVICE, null);
    expect(backend).toBeInstanceOf(AppleScriptInputBackend);
    expect(backend.kind).toBe('applescript');
  });

  // ── Caching / identity ──────────────────────────────────────────────────

  test('caches the simctl detection result', async () => {
    execMock.mockResolvedValueOnce('');
    const first = await getInputBackend(DEVICE);
    const second = await getInputBackend(DEVICE);
    expect(first).toBe(second);
    // Detection probe should only run once
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test('resetInputBackend clears the cache', async () => {
    execMock.mockResolvedValue('');
    await getInputBackend(DEVICE);
    resetInputBackend();
    await getInputBackend(DEVICE);
    // Should probe twice (once before reset, once after)
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  test('WebKitInputBackend is created fresh per call (not cached)', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const mockClient = { isConnected: () => true } as any;
    const first = await getInputBackend(DEVICE, mockClient);
    const second = await getInputBackend(DEVICE, mockClient);
    expect(first).toBeInstanceOf(WebKitInputBackend);
    expect(second).toBeInstanceOf(WebKitInputBackend);
    expect(first).not.toBe(second); // Not cached — client state can change
  });
});
