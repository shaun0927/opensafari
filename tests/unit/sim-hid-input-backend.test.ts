/**
 * Unit tests for SimulatorKitHIDInputBackend (issue #483 PoC).
 *
 * The Swift bridge is spawned via `execFile` (wrapped in `util.promisify`).
 * We mock that wrapper and verify:
 *   - arg construction (tap, swipe, pressKey)
 *   - exit-code → InputBackendError classification
 *   - JSON parse failure surfacing stderr
 *   - tryCreateSimulatorKitHIDBackend returns null when no bridge file exists
 */

import {
  SimulatorKitHIDInputBackend,
  InputBackendError,
  tryCreateSimulatorKitHIDBackend,
  resetSimHidPrivateAPIWarning,
} from '../../src/tools/sim-hid-input-backend';

/* eslint-disable no-var */
var execFileMock = jest.fn();
/* eslint-enable no-var */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execFileMock(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

// Import after mocks so the backend module picks up our stubs.
// (Import is at the top per ESM; fs mock is applied before lookup is called.)
import { existsSync } from 'fs';

const existsSyncMock = existsSync as jest.MockedFunction<typeof existsSync>;

const DEVICE = 'TEST-UDID-1234';
const BRIDGE = '/fake/dist/sim-hid-bridge';

/** Helper: make execFile reject with an exit code like child_process does. */
function execError(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  message?: string;
}): Error {
  const err = new Error(opts.message ?? 'spawn failed') as Error & {
    code?: number | null;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
  };
  err.code = opts.code ?? null;
  err.stdout = opts.stdout ?? '';
  err.stderr = opts.stderr ?? '';
  err.killed = opts.killed ?? false;
  return err;
}

describe('SimulatorKitHIDInputBackend', () => {
  let backend: SimulatorKitHIDInputBackend;

  beforeEach(() => {
    execFileMock.mockReset();
    resetSimHidPrivateAPIWarning();
    backend = new SimulatorKitHIDInputBackend(BRIDGE);
  });

  test('exposes kind="simhid" for observability', () => {
    expect(backend.kind).toBe('simhid');
  });

  test('tap invokes bridge with [udid, "tap", x, y]', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 100, 200);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe(BRIDGE);
    expect(args).toEqual([DEVICE, 'tap', '100', '200']);
  });

  test('tap appends duration when > 0', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 50, 60, 1.5);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'tap', '50', '60', '1.5']);
  });

  test('tap with zero duration omits the duration arg', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 50, 60, 0);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'tap', '50', '60']);
  });

  test('swipe invokes bridge with [udid, "swipe", sx, sy, ex, ey]', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"swipe","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.swipe(DEVICE, 10, 20, 30, 40);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'swipe', '10', '20', '30', '40']);
  });

  test('swipe appends duration when > 0', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"swipe","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.swipe(DEVICE, 10, 20, 30, 40, 0.75);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'swipe', '10', '20', '30', '40', '0.75']);
  });

  test('swipe delegates N-step interpolation to bridge — single call with start/end coords', async () => {
    // Design: The Node wrapper sends only start and end coordinates to the
    // Swift bridge as a single `swipe` command. The bridge internally
    // interpolates N intermediate points (default: 10 steps over the given
    // duration) using kMouseDown -> N x kMouseDragged -> kMouseUp.
    // This test documents that the Node side does NOT decompose the swipe
    // into multiple bridge calls — interpolation is the bridge's responsibility.
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"swipe","udid":"x","elapsed_ms":50}',
      stderr: '',
    });
    await backend.swipe(DEVICE, 0, 500, 0, 100, 0.3);
    // Exactly one bridge invocation for the entire swipe gesture.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0];
    // Only start (0,500) and end (0,100) are passed — no intermediate coords.
    expect(args).toEqual([DEVICE, 'swipe', '0', '500', '0', '100', '0.3']);
  });

  test('pressKey("Enter") sends HID usage 0x28 (40)', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.pressKey(DEVICE, 'Enter');
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'key', String(0x28)]);
  });

  test('pressKey throws InputBackendError for unknown key', async () => {
    await expect(backend.pressKey(DEVICE, 'NopeKey')).rejects.toBeInstanceOf(
      InputBackendError,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('typeText ("ab") spawns bridge once per ASCII character', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.typeText(DEVICE, 'ab');
    expect(execFileMock).toHaveBeenCalledTimes(2);
    // 'a' → 0x04, 'b' → 0x05
    expect(execFileMock.mock.calls[0][1]).toEqual([DEVICE, 'key', String(0x04)]);
    expect(execFileMock.mock.calls[1][1]).toEqual([DEVICE, 'key', String(0x05)]);
  });

  test('typeText throws InputBackendError on non-ASCII input', async () => {
    await expect(backend.typeText(DEVICE, 'café')).rejects.toBeInstanceOf(
      InputBackendError,
    );
  });

  test('typeText with delayMs > 0 inserts pauses between characters (#639 Problem 2)', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    // 4 characters with 30 ms between each → 3 gaps → at least ~75 ms wall
    // clock (allow some slack for setTimeout drift). Without delay, this
    // completes in well under 75 ms because execFile is mocked synchronously.
    const start = Date.now();
    await backend.typeText(DEVICE, 'abcd', 30);
    const elapsed = Date.now() - start;
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(elapsed).toBeGreaterThanOrEqual(75);
  });

  test('typeText with delayMs === 0 keeps existing fast-path (no pause)', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    const start = Date.now();
    await backend.typeText(DEVICE, 'abcd', 0);
    const elapsed = Date.now() - start;
    expect(execFileMock).toHaveBeenCalledTimes(4);
    // No deliberate pause — should complete promptly. Allow generous headroom
    // for CI noise but assert it's well below the delayed-path threshold.
    expect(elapsed).toBeLessThan(60);
  });

  // ── Printable-ASCII symbol coverage (issue #483 follow-up) ────────────────
  // The original PoC only mapped A-Z, a-z, 0-9, and space, so the tool could
  // not type an email address (no '@', '.', or '-'). typeText now covers every
  // printable US-ASCII code point (U+0020..U+007E) and dispatches shifted
  // characters through the bridge's `key-mod` subcommand with LeftShift (0xE1).

  test('typeText unshifted symbols send plain `key` events', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    // Each char maps to a known HID usage on the US layout, no Shift needed.
    const cases: Array<[string, number]> = [
      ['-', 0x2d],
      ['=', 0x2e],
      ['[', 0x2f],
      [']', 0x30],
      ['\\', 0x31],
      [';', 0x33],
      ["'", 0x34],
      ['`', 0x35],
      [',', 0x36],
      ['.', 0x37],
      ['/', 0x38],
    ];
    for (const [ch, usage] of cases) {
      execFileMock.mockClear();
      await backend.typeText(DEVICE, ch);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0][1]).toEqual([DEVICE, 'key', String(usage)]);
    }
  });

  test('typeText shifted symbols send `key-mod` with LeftShift (225)', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key-mod","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    // Each char's key usage + the Shift modifier (0xE1 = 225).
    const cases: Array<[string, number]> = [
      ['!', 0x1e],
      ['@', 0x1f],
      ['#', 0x20],
      ['$', 0x21],
      ['%', 0x22],
      ['^', 0x23],
      ['&', 0x24],
      ['*', 0x25],
      ['(', 0x26],
      [')', 0x27],
      ['_', 0x2d],
      ['+', 0x2e],
      ['{', 0x2f],
      ['}', 0x30],
      ['|', 0x31],
      [':', 0x33],
      ['"', 0x34],
      ['~', 0x35],
      ['<', 0x36],
      ['>', 0x37],
      ['?', 0x38],
    ];
    for (const [ch, usage] of cases) {
      execFileMock.mockClear();
      await backend.typeText(DEVICE, ch);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0][1]).toEqual([
        DEVICE,
        'key-mod',
        String(usage),
        String(0xe1),
      ]);
    }
  });

  test('typeText uppercase letters send `key-mod` with Shift (was silently lowercased before)', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key-mod","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.typeText(DEVICE, 'A');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // 'A' → same HID usage as 'a' (0x04) with Shift (0xE1 = 225).
    expect(execFileMock.mock.calls[0][1]).toEqual([
      DEVICE,
      'key-mod',
      String(0x04),
      String(0xe1),
    ]);
  });

  test('typeText composes a realistic email address correctly', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"key","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.typeText(DEVICE, 'a@b.c');
    expect(execFileMock).toHaveBeenCalledTimes(5);
    expect(execFileMock.mock.calls[0][1]).toEqual([DEVICE, 'key', String(0x04)]); // 'a'
    expect(execFileMock.mock.calls[1][1]).toEqual([DEVICE, 'key-mod', String(0x1f), String(0xe1)]); // '@'
    expect(execFileMock.mock.calls[2][1]).toEqual([DEVICE, 'key', String(0x05)]); // 'b'
    expect(execFileMock.mock.calls[3][1]).toEqual([DEVICE, 'key', String(0x37)]); // '.'
    expect(execFileMock.mock.calls[4][1]).toEqual([DEVICE, 'key', String(0x06)]); // 'c'
  });

  test('typeText rejects control characters (tab, newline, DEL) with unsupported-character error', async () => {
    for (const ch of ['\t', '\n', '\r', '\x00', '\x7f']) {
      const p = backend.typeText(DEVICE, ch);
      await expect(p).rejects.toBeInstanceOf(InputBackendError);
      await expect(p).rejects.toMatchObject({ code: 'BAD_ARGS' });
      await expect(p).rejects.toThrow(/unsupported character/);
    }
  });

  // ── Exit-code classification ─────────────────────────────────────────────

  test('exit 99 → InputBackendError code "NOT_IMPLEMENTED"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 99,
      stdout: '{"ok":false,"error":"stub","code":"NOT_IMPLEMENTED"}',
      stderr: '',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'NOT_IMPLEMENTED',
    });
  });

  test('exit 78 → InputBackendError code "SIMULATORKIT_UNAVAILABLE"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 78,
      stderr: 'dlopen failed',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'SIMULATORKIT_UNAVAILABLE',
    });
  });

  test('exit 78 error message references docs/private-apis.md', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 78,
      stderr: 'dlopen failed',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toThrow(/docs\/private-apis\.md/);
  });

  test('exit 99 error message references docs/private-apis.md', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 99,
      stderr: 'stub path',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toThrow(/docs\/private-apis\.md/);
  });

  test('non-SimulatorKit exit codes do not leak the private-apis hint', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 64,
      stderr: 'usage',
    }));
    // BAD_ARGS is a caller bug, not an Apple BC break — no doc pointer.
    await expect(backend.tap(DEVICE, 1, 2)).rejects.not.toThrow(/private-apis\.md/);
  });

  test('exit 69 → InputBackendError code "DEVICE_NOT_BOOTED"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 69,
      stderr: 'device not booted',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'DEVICE_NOT_BOOTED',
    });
  });

  test('exit 64 → InputBackendError code "BAD_ARGS"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 64,
      stderr: 'usage',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'BAD_ARGS',
    });
  });

  test('other non-zero exit → "UNKNOWN" and surfaces stderr', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 42,
      stderr: 'boom',
    }));
    const p = backend.tap(DEVICE, 1, 2);
    await expect(p).rejects.toBeInstanceOf(InputBackendError);
    await expect(p).rejects.toMatchObject({
      code: 'UNKNOWN',
      stderr: 'boom',
    });
    await expect(p).rejects.toThrow(/boom/);
  });

  test('killed by timeout → "SPAWN_TIMEOUT"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      killed: true,
      stderr: '',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      code: 'SPAWN_TIMEOUT',
    });
  });

  test('non-JSON stdout on success → "JSON_PARSE_FAILURE"', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: 'not-json',
      stderr: 'warn: something',
    });
    const p = backend.tap(DEVICE, 1, 2);
    await expect(p).rejects.toBeInstanceOf(InputBackendError);
    await expect(p).rejects.toMatchObject({
      code: 'JSON_PARSE_FAILURE',
      stderr: 'warn: something',
    });
  });

  test('JSON { ok: false } on exit 0 still surfaces as InputBackendError', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":false,"error":"nope","code":"NOT_IMPLEMENTED"}',
      stderr: '',
    });
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  // Private-API warning latch is tested in the dedicated describe block below.

  test('exit 78 → thrown message contains "See docs/private-apis.md"', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 78,
      stderr: 'dlopen failed',
    }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
        code: 'SIMULATORKIT_UNAVAILABLE',
        message: expect.stringContaining('See docs/private-apis.md'),
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('{ok:false, code:"SIMULATORKIT_MISSING"} → thrown message contains "See docs/private-apis.md"', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":false,"error":"framework missing","code":"SIMULATORKIT_MISSING"}',
      stderr: '',
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
        message: expect.stringContaining('See docs/private-apis.md'),
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('{ok:false, code:"NOT_IMPLEMENTED"} → thrown message does NOT contain "docs/private-apis.md"', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":false,"error":"stub","code":"NOT_IMPLEMENTED"}',
      stderr: '',
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(backend.tap(DEVICE, 1, 2)).rejects.toMatchObject({
        message: expect.not.stringContaining('docs/private-apis.md'),
      });
    } finally {
      spy.mockRestore();
    }
  });

  // ── Bridge resolution via swift interpreter ──────────────────────────────

  test('resolves .swift source via `swift` interpreter', async () => {
    const source = '/tmp/sim-hid-bridge.swift';
    const swiftBackend = new SimulatorKitHIDInputBackend(source);
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await swiftBackend.tap(DEVICE, 3, 4);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('swift');
    expect(args).toEqual([source, DEVICE, 'tap', '3', '4']);
  });
});

// ── Factory function ────────────────────────────────────────────────────────

describe('tryCreateSimulatorKitHIDBackend', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
  });

  test('throws InputBackendError HID_BRIDGE_MISSING when no bridge artifact is present', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(tryCreateSimulatorKitHIDBackend()).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'HID_BRIDGE_MISSING',
    });
  });

  test('HID_BRIDGE_MISSING error message lists searched paths', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(tryCreateSimulatorKitHIDBackend()).rejects.toThrow(
      /sim-hid-bridge not found/,
    );
  });

  test('returns a backend when a candidate file exists', async () => {
    // Accept the first candidate (compiled binary path)
    existsSyncMock.mockImplementation(() => true);
    const result = await tryCreateSimulatorKitHIDBackend();
    expect(result).toBeInstanceOf(SimulatorKitHIDInputBackend);
    expect(result?.kind).toBe('simhid');
  });
});

// ── Private-API warning latch (issue #493) ─────────────────────────────────

describe('SimulatorKitHIDInputBackend private-API warning', () => {
  let backend: SimulatorKitHIDInputBackend;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    execFileMock.mockReset();
    resetSimHidPrivateAPIWarning();
    backend = new SimulatorKitHIDInputBackend('/fake/dist/sim-hid-bridge');
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('emits a stderr notice the first time sim-hid-bridge is spawned', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 1, 2);
    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('SimulatorKit'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toMatch(/docs\/private-apis\.md/);
    // Issue #601: warning must signal deployment scope (host/CI only, not iOS .ipa)
    expect(warningCalls[0][0]).toMatch(/Where can I use this\?/);
    expect(warningCalls[0][0]).toMatch(/macOS host \/ CI only/);
    expect(warningCalls[0][0]).toMatch(/never bundle inside an iOS \.ipa/);
    expect(warningCalls[0][0]).toMatch(/Deployment scope/);
  });

  test('does not re-emit the notice on subsequent spawns', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 1, 2);
    await backend.tap(DEVICE, 3, 4);
    await backend.tap(DEVICE, 5, 6);
    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('SimulatorKit'),
    );
    expect(warningCalls).toHaveLength(1);
  });

  test('emits the notice even when the spawn itself fails (CI operator visibility)', async () => {
    execFileMock.mockRejectedValueOnce(execError({
      code: 78,
      stderr: 'dlopen failed',
    }));
    await expect(backend.tap(DEVICE, 1, 2)).rejects.toBeInstanceOf(InputBackendError);
    // The notice fires before the exec call — so even a bridge that exits 78
    // (SimulatorKit missing) still surfaces the private-API context.
    const privateApiCalls = stderrSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('private Apple frameworks'),
    );
    expect(privateApiCalls).toHaveLength(1);
  });
});
