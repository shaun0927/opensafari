/**
 * NativeInputBackend — Abstraction layer for sending input events to iOS Simulator.
 *
 * Provides two backends:
 *   1. SimctlInputBackend  — uses `xcrun simctl io <device> input` (Xcode 15–16)
 *   2. AppleScriptInputBackend — uses osascript + CGEvent (Xcode 26+)
 *
 * Auto-detects which backend to use at first invocation and caches the result.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimctlExecutor } from '../simulator/simctl';

const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface InputBackend {
  tap(deviceId: string, x: number, y: number, duration?: number): Promise<void>;
  swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void>;
  typeText(deviceId: string, text: string): Promise<void>;
  keypress(deviceId: string, keyCode: string): Promise<void>;
  sendKey(deviceId: string, keyName: string): Promise<void>;
}

// ── SimctlInputBackend ───────────────────────────────────────────────────────

/**
 * Uses `xcrun simctl io <device> input` subcommands.
 * Available on Xcode versions that ship the `input` subcommand (typically ≤ 16).
 */
export class SimctlInputBackend implements InputBackend {
  private simctl: SimctlExecutor;

  constructor(simctl?: SimctlExecutor) {
    this.simctl = simctl ?? new SimctlExecutor();
  }

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    if (duration && duration > 0) {
      await this.simctl.exec([
        'io', deviceId, 'input', 'press',
        String(x), String(y), String(duration),
      ]);
    } else {
      await this.simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
    }
  }

  async swipe(
    deviceId: string,
    startX: number, startY: number,
    endX: number, endY: number,
    duration?: number,
  ): Promise<void> {
    try {
      await this.simctl.exec([
        'io', deviceId, 'input', 'swipe',
        String(startX), String(startY), String(endX), String(endY),
      ]);
    } catch {
      // Fallback: `drag` accepts a duration argument
      await this.simctl.exec([
        'io', deviceId, 'input', 'drag',
        String(startX), String(startY), String(endX), String(endY),
        String(duration ?? 0.5),
      ]);
    }
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await this.simctl.exec(['io', deviceId, 'input', 'text', text]);
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await this.simctl.exec(['io', deviceId, 'input', 'keypress', keyCode]);
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await this.simctl.exec(['io', deviceId, 'sendkey', keyName]);
  }
}

// ── AppleScriptInputBackend ──────────────────────────────────────────────────

/**
 * AppleScript key-code mapping (macOS virtual key codes).
 * Used to translate HID key codes and key names to AppleScript `key code` values.
 */
const HID_TO_APPLESCRIPT: Record<string, number> = {
  '40': 36,  // Return / Enter
  '41': 53,  // Escape
  '42': 51,  // Backspace / Delete
  '43': 48,  // Tab
  '44': 49,  // Space
  '74': 115, // Home
  '79': 124, // Right arrow
  '80': 123, // Left arrow
  '81': 125, // Down arrow
  '82': 126, // Up arrow
};

const SENDKEY_TO_APPLESCRIPT: Record<string, number> = {
  Return: 36,
  Escape: 53,
  Tab: 48,
  Space: 49,
  Delete: 51,
  Home: 115,
};

/**
 * Uses AppleScript (`osascript`) and Swift CGEvent for input.
 * Works on any Xcode version as it bypasses `simctl io input` entirely.
 *
 * Requires:
 *   - Accessibility permissions for System Events
 *   - Simulator app running and visible
 *
 * Coordinate translation assumes Simulator is at default "Point Accurate" (1:1) zoom.
 */
export class AppleScriptInputBackend implements InputBackend {
  /** macOS title bar height in points. */
  private static readonly TITLE_BAR_HEIGHT = 28;

  private async runAppleScript(lines: string[]): Promise<string> {
    const args = lines.flatMap((line) => ['-e', line]);
    const { stdout } = await execFileAsync('osascript', args, { timeout: 10_000 });
    return stdout.trim();
  }

  private async activateSimulator(): Promise<void> {
    await this.runAppleScript(['tell application "Simulator" to activate']);
    await delay(150);
  }

  /**
   * Get the Simulator window's content-area origin in macOS screen coordinates.
   * Content area = window origin + title-bar offset.
   */
  async getSimulatorContentOrigin(): Promise<{ x: number; y: number }> {
    const result = await this.runAppleScript([
      'tell application "System Events"',
      '  tell process "Simulator"',
      '    set winPos to position of window 1',
      '    set x to item 1 of winPos',
      '    set y to item 2 of winPos',
      '    return (x as text) & "," & (y as text)',
      '  end tell',
      'end tell',
    ]);
    const [x, y] = result.split(',').map(Number);
    return { x, y: y + AppleScriptInputBackend.TITLE_BAR_HEIGHT };
  }

  /**
   * Translate iOS point coordinates to absolute macOS screen coordinates.
   * Assumes 1:1 point mapping (Simulator at default zoom).
   */
  private async toScreen(x: number, y: number): Promise<{ sx: number; sy: number }> {
    const origin = await this.getSimulatorContentOrigin();
    return {
      sx: Math.round(origin.x + x),
      sy: Math.round(origin.y + y),
    };
  }

  async tap(_deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await this.activateSimulator();
    const { sx, sy } = await this.toScreen(x, y);

    if (duration && duration > 0) {
      // Long press: mouse down → wait → mouse up via Swift CGEvent
      await execFileAsync('swift', ['-e', [
        'import Cocoa',
        `let p = CGPoint(x: ${sx}, y: ${sy})`,
        'CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)',
        `Thread.sleep(forTimeInterval: ${duration})`,
        'CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)',
      ].join('\n')], { timeout: Math.max(15_000, duration * 1000 + 5000) });
    } else {
      await this.runAppleScript([
        `tell application "System Events" to click at {${sx}, ${sy}}`,
      ]);
    }
  }

  async swipe(
    _deviceId: string,
    startX: number, startY: number,
    endX: number, endY: number,
    duration?: number,
  ): Promise<void> {
    await this.activateSimulator();
    // Get origin once for both start and end coordinates
    const origin = await this.getSimulatorContentOrigin();
    const sx = Math.round(origin.x + startX);
    const sy = Math.round(origin.y + startY);
    const ex = Math.round(origin.x + endX);
    const ey = Math.round(origin.y + endY);
    const dur = duration ?? 0.5;
    const steps = 20;
    const stepDelay = dur / steps;

    // Mouse drag via Swift CGEvent (macOS built-in, no external deps)
    await execFileAsync('swift', ['-e', [
      'import Cocoa',
      `let x1: CGFloat = ${sx}, y1: CGFloat = ${sy}`,
      `let x2: CGFloat = ${ex}, y2: CGFloat = ${ey}`,
      `let steps = ${steps}`,
      `let stepDelay = ${stepDelay}`,
      'CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x1, y: y1), mouseButton: .left)!.post(tap: .cghidEventTap)',
      'Thread.sleep(forTimeInterval: 0.05)',
      'for i in 1...steps {',
      '  let t = CGFloat(i) / CGFloat(steps)',
      '  let p = CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)',
      '  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)',
      '  Thread.sleep(forTimeInterval: stepDelay)',
      '}',
      'CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x2, y: y2), mouseButton: .left)!.post(tap: .cghidEventTap)',
    ].join('\n')], { timeout: 15_000 });
  }

  async typeText(_deviceId: string, text: string): Promise<void> {
    await this.activateSimulator();
    // Escape special AppleScript characters
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await this.runAppleScript([
      `tell application "System Events" to keystroke "${escaped}"`,
    ]);
  }

  async keypress(_deviceId: string, keyCode: string): Promise<void> {
    await this.activateSimulator();
    const asKeyCode = HID_TO_APPLESCRIPT[keyCode];
    if (asKeyCode === undefined) {
      throw new Error(
        `Unknown HID key code "${keyCode}" for AppleScript backend. ` +
        `Supported: ${Object.keys(HID_TO_APPLESCRIPT).join(', ')}`,
      );
    }
    await this.runAppleScript([
      `tell application "System Events" to key code ${asKeyCode}`,
    ]);
  }

  async sendKey(_deviceId: string, keyName: string): Promise<void> {
    await this.activateSimulator();
    const asKeyCode = SENDKEY_TO_APPLESCRIPT[keyName];
    if (asKeyCode === undefined) {
      throw new Error(
        `Unknown key name "${keyName}" for AppleScript backend. ` +
        `Supported: ${Object.keys(SENDKEY_TO_APPLESCRIPT).join(', ')}`,
      );
    }
    await this.runAppleScript([
      `tell application "System Events" to key code ${asKeyCode}`,
    ]);
  }
}

// ── Backend detection & singleton ────────────────────────────────────────────

let cachedBackend: InputBackend | null = null;
let detectionPromise: Promise<InputBackend> | null = null;

/**
 * Probe whether `simctl io input` is available by attempting a no-op tap at (0,0).
 */
async function detectBackend(deviceId: string): Promise<InputBackend> {
  const simctl = new SimctlExecutor();
  try {
    await simctl.exec(['io', deviceId, 'input', 'tap', '0', '0'], { timeout: 5000 });
    return new SimctlInputBackend(simctl);
  } catch {
    console.error(
      '[input-backend] simctl io input unavailable — using AppleScript/CGEvent fallback',
    );
    return new AppleScriptInputBackend();
  }
}

/**
 * Get the input backend, auto-detecting on first call.
 * The result is cached for the process lifetime.
 */
export async function getInputBackend(deviceId: string): Promise<InputBackend> {
  if (cachedBackend) return cachedBackend;

  if (!detectionPromise) {
    detectionPromise = detectBackend(deviceId).then((backend) => {
      cachedBackend = backend;
      return backend;
    });
  }

  return detectionPromise;
}

/** Reset the cached backend. Exported for testing only. */
export function resetInputBackend(): void {
  cachedBackend = null;
  detectionPromise = null;
}

// Re-export for convenience
export { HID_TO_APPLESCRIPT, SENDKEY_TO_APPLESCRIPT };
