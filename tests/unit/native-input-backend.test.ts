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

  test('tap activates Simulator and calls osascript click', async () => {
    // First call: activate Simulator
    // Second call: get window position
    // Third call: click at coordinates
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })       // activate
      .mockResolvedValueOnce({ stdout: '100,200', stderr: '' }) // window position
      .mockResolvedValueOnce({ stdout: '', stderr: '' });       // click

    await backend.tap(DEVICE, 50, 100);

    // Third call should be the click at translated coordinates
    // Window at (100, 200), title bar = 28, so content origin = (100, 228)
    // iOS (50, 100) → screen (150, 328)
    const clickCall = execFileMock.mock.calls[2];
    expect(clickCall[0]).toBe('osascript');
    expect(clickCall[1]).toContain(
      'tell application "System Events" to click at {150, 328}',
    );
  });

  test('tap with duration uses Swift CGEvent for long press', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })       // activate
      .mockResolvedValueOnce({ stdout: '0,0', stderr: '' })   // window position
      .mockResolvedValueOnce({ stdout: '', stderr: '' });      // swift CGEvent

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
      .mockResolvedValueOnce({ stdout: '', stderr: '' })       // activate
      .mockResolvedValueOnce({ stdout: '50,100', stderr: '' }) // window position
      .mockResolvedValueOnce({ stdout: '', stderr: '' });      // swift

    await backend.swipe(DEVICE, 200, 600, 200, 200, 0.5);

    const swiftCall = execFileMock.mock.calls[2];
    expect(swiftCall[0]).toBe('swift');
    const script = swiftCall[1][1];
    expect(script).toContain('leftMouseDown');
    expect(script).toContain('leftMouseDragged');
    expect(script).toContain('leftMouseUp');
  });

  test('getSimulatorContentOrigin parses window position', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '300,150\n', stderr: '' });

    const origin = await backend.getSimulatorContentOrigin();
    expect(origin).toEqual({ x: 300, y: 178 }); // 150 + 28 title bar
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
  });

  test('returns WebKitInputBackend when simctl fails but webkitClient is connected', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const mockClient = { isConnected: () => true } as any;
    const backend = await getInputBackend(DEVICE, mockClient);
    expect(backend).toBeInstanceOf(WebKitInputBackend);
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
  });

  test('returns AppleScriptInputBackend when OPENSAFARI_ALLOW_FOCUS_INPUT=true', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV] = 'true';
    const backend = await getInputBackend(DEVICE);
    expect(backend).toBeInstanceOf(AppleScriptInputBackend);
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
