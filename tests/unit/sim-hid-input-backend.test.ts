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

  // ── Private-API warning latch ────────────────────────────────────────────

  test('first run() emits exactly one warning mentioning SimulatorKit and docs/private-apis.md', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await backend.tap(DEVICE, 1, 2);
      const calls = spy.mock.calls.filter((c) => {
        const msg = String(c[0]);
        return msg.includes('SimulatorKit') && msg.includes('docs/private-apis.md');
      });
      expect(calls).toHaveLength(1);

      // Second run must NOT emit an additional warning.
      spy.mockClear();
      await backend.tap(DEVICE, 3, 4);
      const calls2 = spy.mock.calls.filter((c) => {
        const msg = String(c[0]);
        return msg.includes('SimulatorKit') && msg.includes('docs/private-apis.md');
      });
      expect(calls2).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

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

  test('returns null when no bridge artifact is present', async () => {
    existsSyncMock.mockReturnValue(false);
    const result = await tryCreateSimulatorKitHIDBackend();
    expect(result).toBeNull();
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
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/SimulatorKit/);
    expect(msg).toMatch(/docs\/private-apis\.md/);
  });

  test('does not re-emit the notice on subsequent spawns', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":true,"kind":"tap","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 1, 2);
    await backend.tap(DEVICE, 3, 4);
    await backend.tap(DEVICE, 5, 6);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
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
      typeof call[0] === 'string' && call[0].includes('docs/private-apis.md'),
    );
    expect(privateApiCalls).toHaveLength(1);
  });
});
