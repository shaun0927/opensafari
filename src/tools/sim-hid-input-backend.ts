/**
 * SimulatorKitHIDInputBackend — Node wrapper around the `sim-hid-bridge`
 * Swift helper described in issue #483.
 *
 * Status: PoC. Backend class is shipped for integration and unit testing, but
 * routing in `native-input-backend.ts` is intentionally NOT wired up yet. See
 * the `TODO(#483)` comment there.
 *
 * The Swift bridge spawns as a short-lived child process and communicates via
 * argv (command) + stdout (newline-terminated JSON). Exit codes are the
 * contract between Swift and Node:
 *
 *   0  — success
 *   64 — BAD_ARGS          (EX_USAGE)
 *   69 — DEVICE_NOT_BOOTED (EX_UNAVAILABLE)
 *   78 — SIMULATORKIT_UNAVAILABLE (EX_CONFIG — dlopen failed)
 *   99 — NOT_IMPLEMENTED   (PoC stub path)
 *   * — UNKNOWN (stderr surfaced verbatim)
 *
 * The current Swift implementation is a PoC stub that proves the dlopen path
 * works and always exits with 99 NOT_IMPLEMENTED. This wrapper classifies that
 * (and every other documented exit code) into a structured `InputBackendError`
 * so the routing layer can decide to fall through to the next tier.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as path from 'path';
import type { InputBackend } from './native-input-backend';

const execFileAsync = promisify(execFile);

/** Spawn timeout for the Swift helper. Matches idb's default. */
const SPAWN_TIMEOUT_MS = 10_000;

/** HID usage page 0x07 (Keyboard/Keypad) — subset we map for pressKey(). */
const KEY_NAME_TO_HID_USAGE: Record<string, number> = {
  Enter: 0x28,
  Return: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Delete: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  Home: 0x4a,
};

/** ASCII → HID usage code (subset — PoC only covers A–Z, 0–9, space). */
function asciiToHidUsage(ch: string): number | null {
  const code = ch.charCodeAt(0);
  // Lowercase / uppercase letters → HID 0x04 .. 0x1D (a..z)
  if (code >= 97 && code <= 122) return 0x04 + (code - 97);
  if (code >= 65 && code <= 90) return 0x04 + (code - 65);
  // Digits: '1'..'9' → 0x1E..0x26, '0' → 0x27
  if (code >= 49 && code <= 57) return 0x1e + (code - 49);
  if (code === 48) return 0x27;
  if (code === 32) return 0x2c; // Space
  return null;
}

/**
 * Error emitted by `SimulatorKitHIDInputBackend`. Mirrors the convention used
 * by `AccessibilityBridgeError` (see `src/native/accessibility-bridge.ts`):
 * a stable machine-readable `code` plus the human-readable `message`.
 */
export class InputBackendError extends Error {
  readonly name = 'InputBackendError' as const;
  constructor(
    message: string,
    public readonly code: InputBackendErrorCode,
    public readonly stderr?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, InputBackendError.prototype);
  }
}

export type InputBackendErrorCode =
  | 'BAD_ARGS'
  | 'DEVICE_NOT_BOOTED'
  | 'SIMULATORKIT_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'SPAWN_TIMEOUT'
  | 'BRIDGE_NOT_FOUND'
  | 'JSON_PARSE_FAILURE'
  | 'UNKNOWN';

/** Map Swift bridge exit codes to structured error codes. */
function codeForExit(exit: number | undefined): InputBackendErrorCode {
  switch (exit) {
    case 64: return 'BAD_ARGS';
    case 69: return 'DEVICE_NOT_BOOTED';
    case 78: return 'SIMULATORKIT_UNAVAILABLE';
    case 99: return 'NOT_IMPLEMENTED';
    default: return 'UNKNOWN';
  }
}

/**
 * SimulatorKit HID input backend. Spawns `sim-hid-bridge` per call and parses
 * the JSON status envelope. All methods throw `InputBackendError` on failure.
 */
export class SimulatorKitHIDInputBackend implements InputBackend {
  readonly kind = 'simhid' as const;

  constructor(private readonly bridgePath: string) {}

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    const args = [deviceId, 'tap', String(x), String(y)];
    if (duration !== undefined && duration > 0) {
      args.push(String(duration));
    }
    await this.run(args);
  }

  async swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void> {
    const args = [
      deviceId, 'swipe',
      String(startX), String(startY),
      String(endX), String(endY),
    ];
    if (duration !== undefined && duration > 0) {
      args.push(String(duration));
    }
    await this.run(args);
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    // PoC: ASCII-only. Each character is converted to a HID usage and sent
    // as an independent `key` event. Non-ASCII characters are rejected until
    // the Swift bridge gains a text-composition path.
    for (const ch of text) {
      const usage = asciiToHidUsage(ch);
      if (usage === null) {
        throw new InputBackendError(
          `SimulatorKitHIDInputBackend.typeText: non-ASCII character '${ch}' ` +
            'is not supported in the PoC. Track follow-up in issue #483.',
          'BAD_ARGS',
        );
      }
      await this.run([deviceId, 'key', String(usage)]);
    }
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    // Accept either a decimal HID usage code or a key name known to our map.
    const parsed = Number.parseInt(keyCode, 10);
    const usage = Number.isNaN(parsed) ? KEY_NAME_TO_HID_USAGE[keyCode] : parsed;
    if (usage === undefined) {
      throw new InputBackendError(
        `SimulatorKitHIDInputBackend.keypress: unknown HID key code "${keyCode}"`,
        'BAD_ARGS',
      );
    }
    await this.run([deviceId, 'key', String(usage)]);
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await this.pressKey(deviceId, keyName);
  }

  /** Convenience alias: resolve a symbolic key name to its HID usage. */
  async pressKey(deviceId: string, key: string): Promise<void> {
    const usage = KEY_NAME_TO_HID_USAGE[key];
    if (usage === undefined) {
      throw new InputBackendError(
        `SimulatorKitHIDInputBackend.pressKey: unknown key "${key}". ` +
          `Supported: ${Object.keys(KEY_NAME_TO_HID_USAGE).join(', ')}`,
        'BAD_ARGS',
      );
    }
    await this.run([deviceId, 'key', String(usage)]);
  }

  /**
   * Spawn the bridge with the given argv (not including the bridge path)
   * and parse its JSON stdout. Surfaces every documented exit code as a
   * structured `InputBackendError`.
   */
  private async run(args: string[]): Promise<unknown> {
    const { cmd, cmdArgs } = this.resolveSpawn(args);
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(cmd, cmdArgs, {
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: 1 * 1024 * 1024,
      });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';

      if (e.killed && e.code === null) {
        throw new InputBackendError(
          `sim-hid-bridge timed out after ${SPAWN_TIMEOUT_MS}ms`,
          'SPAWN_TIMEOUT',
          stderr,
        );
      }

      const exit = typeof e.code === 'number' ? e.code : undefined;
      const classified = codeForExit(exit);
      const hint = stderr.trim() || stdout.trim() || e.message;
      throw new InputBackendError(
        `sim-hid-bridge exited ${exit ?? '?'}: ${hint}`,
        classified,
        stderr,
      );
    }

    // Successful spawn: parse the JSON envelope. A bridge that exits 0 but
    // emits `{ ok: false, ... }` is treated as a structured failure too.
    if (!stdout.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string; code?: string };
      if (parsed.ok === false) {
        throw new InputBackendError(
          parsed.error ?? 'sim-hid-bridge reported ok=false',
          (parsed.code as InputBackendErrorCode | undefined) ?? 'UNKNOWN',
          stderr,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof InputBackendError) throw err;
      throw new InputBackendError(
        `sim-hid-bridge produced non-JSON stdout: ${stdout.slice(0, 200)}`,
        'JSON_PARSE_FAILURE',
        stderr,
      );
    }
  }

  /**
   * Decide how to invoke the bridge: as a compiled binary, or via the `swift`
   * interpreter when only the .swift source is present (PoC fallback).
   */
  private resolveSpawn(args: string[]): { cmd: string; cmdArgs: string[] } {
    if (this.bridgePath.endsWith('.swift')) {
      return { cmd: 'swift', cmdArgs: [this.bridgePath, ...args] };
    }
    return { cmd: this.bridgePath, cmdArgs: args };
  }
}

/**
 * Attempt to locate a usable sim-hid-bridge. Returns a ready-to-use backend
 * or `null` if the helper is not installed on this machine. Callers are
 * expected to fall through to another tier in that case.
 *
 * Lookup order:
 *   1. Compiled binary at `dist/sim-hid-bridge` (next to `dist/ax-bridge`).
 *   2. Swift source at `src/native/sim-hid-bridge.swift` (interpreted via
 *      `swift dist/sim-hid-bridge.swift` after `npm run build`).
 *   3. Swift source at `dist/sim-hid-bridge.swift` (post-build copy).
 */
export async function tryCreateSimulatorKitHIDBackend(): Promise<
  SimulatorKitHIDInputBackend | null
> {
  const candidates = [
    // Compiled binary co-located with ax-bridge after build.
    path.resolve(__dirname, '..', 'sim-hid-bridge'),
    path.resolve(__dirname, 'sim-hid-bridge'),
    // Swift source copied into dist/ by the postbuild step.
    path.resolve(__dirname, '..', 'sim-hid-bridge.swift'),
    path.resolve(__dirname, 'sim-hid-bridge.swift'),
    // Source tree fallback for `npm run dev` and integration tests.
    path.resolve(__dirname, '..', '..', 'src', 'native', 'sim-hid-bridge.swift'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return new SimulatorKitHIDInputBackend(candidate);
    }
  }
  return null;
}
