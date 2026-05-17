/**
 * AppleScriptInputBackend — uses AppleScript (`osascript`) and Swift CGEvent.
 *
 * This backend is **default-deny**: it is only instantiated when the caller
 * explicitly opts in via `OPENSAFARI_ALLOW_FOCUS_INPUT=1`. Without the opt-in,
 * `getInputBackend()` throws `HeadlessInputUnavailableError` instead, preventing
 * the surprising focus-theft / mouse-movement behavior that motivated issues
 * #403 and #405.
 *
 * Works on any Xcode version as it bypasses `simctl io input` entirely.
 *
 * Requires:
 *   - Accessibility permissions for System Events
 *   - Simulator app running and visible
 *
 * Coordinate translation assumes Simulator is at default "Point Accurate" (1:1) zoom.
 *
 * Split from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. Behavior is strictly unchanged.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { timedInput } from '../metrics/input-telemetry';
import type { InputBackend } from './backend';

const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AppleScript key-code mapping (macOS virtual key codes).
 * Used to translate HID key codes and key names to AppleScript `key code` values.
 */
export const HID_TO_APPLESCRIPT: Record<string, number> = {
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

export const SENDKEY_TO_APPLESCRIPT: Record<string, number> = {
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
 */
export class AppleScriptInputBackend implements InputBackend {
  readonly kind = 'applescript' as const;

  /**
   * Per-device cache for the resolved content origin.
   * Key: deviceId, Value: { x, y, winX, winY } where winX/winY is the window
   * top-left at the time of the last measurement (used to detect window moves).
   */
  private originCache = new Map<string, { x: number; y: number; winX: number; winY: number }>();

  /** Set of deviceIds that have already emitted the AX fallback warning. */
  private warnedDevices = new Set<string>();

  /**
   * Timestamp of the last successful Simulator activation (ms since epoch).
   * Retained for observability and potential future diagnostics; no longer
   * used to gate the frontmost-app check — every `activateSimulator()` call
   * queries System Events to confirm current focus state before deciding
   * whether to activate.
   *
   * This field is scoped to the AppleScript backend instance and does NOT
   * affect any headless tier. It is NOT shared with `getInputBackend()`.
   */
  private static readonly ACTIVATION_CACHE_TTL_MS = 500;
  private lastActivationAt = 0;

  private async runAppleScript(lines: string[]): Promise<string> {
    const args = lines.flatMap((line) => ['-e', line]);
    const { stdout } = await execFileAsync('osascript', args, { timeout: 10_000 });
    return stdout.trim();
  }

  /**
   * Activate Simulator.app via AppleScript when it is not already frontmost.
   *
   * On every call we query System Events for the current frontmost process
   * name. If Simulator is already frontmost we skip the `activate` call and
   * the 150 ms settle delay — the frontmost check is a single cheap osascript
   * IPC round-trip (~5–10 ms) and is always correct regardless of how recently
   * the last activation occurred.
   *
   * `lastActivationAt` is retained for observability / future diagnostics but
   * no longer gates the frontmost check — removing the TTL early-return
   * ensures input is never delivered to the wrong app when focus changes
   * between consecutive calls in a burst.
   *
   * This optimisation applies ONLY to the opt-in focus-stealing path —
   * all headless backends skip this method entirely.
   */
  private async activateSimulator(): Promise<void> {
    // Always check frontmost state; the IPC cost (~5–10 ms) is cheaper than
    // the risk of delivering input to the wrong app after a focus change.
    const frontApp = await this.runAppleScript([
      'tell application "System Events" to set frontApp to name of first application process whose frontmost is true',
      'return frontApp',
    ]);
    if (frontApp !== 'Simulator') {
      await this.runAppleScript(['tell application "Simulator" to activate']);
      await delay(150);
    }
    this.lastActivationAt = Date.now();
  }

  /**
   * Get the Simulator window's content-area origin in macOS screen coordinates
   * by querying the position of the first child UI element (the iOS device
   * content area within the macOS window). This avoids hardcoding any title-bar
   * height offset and handles Xcode 26 where the AX bridge already returns
   * frames in window-relative coordinates.
   *
   * On any AppleScript failure, falls back to the raw window position (offset 0)
   * and emits one `console.error` warning per device. The result is cached per
   * deviceId; pass `{ refresh: true }` to invalidate the cache.
   */
  async getSimulatorContentOrigin(
    deviceId: string,
    options?: { refresh?: boolean },
  ): Promise<{ x: number; y: number }> {
    if (!options?.refresh) {
      const cached = this.originCache.get(deviceId);
      if (cached) {
        return { x: cached.x, y: cached.y };
      }
    }

    let winX = 0;
    let winY = 0;
    let contentX = 0;
    let contentY = 0;

    try {
      const result = await this.runAppleScript([
        'tell application "System Events"',
        '  tell process "Simulator"',
        '    set winPos to position of window 1',
        '    set wx to item 1 of winPos',
        '    set wy to item 2 of winPos',
        '    set childPos to position of UI element 1 of window 1',
        '    set cx to item 1 of childPos',
        '    set cy to item 2 of childPos',
        '    return (wx as text) & "," & (wy as text) & "|" & (cx as text) & "," & (cy as text)',
        '  end tell',
        'end tell',
      ]);

      const [winPart, childPart] = result.split('|');
      if (!winPart || !childPart) {
        throw new Error(`Unexpected AX output: ${result}`);
      }
      const [px, py] = winPart.split(',').map(Number);
      const [cx, cy] = childPart.split(',').map(Number);
      if ([px, py, cx, cy].some((n) => !isFinite(n))) {
        throw new Error(`Non-numeric values in AX output: ${result}`);
      }
      winX = px;
      winY = py;
      contentX = cx;
      contentY = cy;
    } catch (err) {
      // Fallback: use raw window position (zero title-bar offset).
      // Only warn once per device to avoid log spam.
      if (!this.warnedDevices.has(deviceId)) {
        this.warnedDevices.add(deviceId);
        console.error(
          `[input-backend] AppleScript AX content-origin query failed for device ${deviceId}; ` +
          `falling back to window position (offset 0). ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Attempt a simpler query to get the window position for the fallback.
      try {
        const winResult = await this.runAppleScript([
          'tell application "System Events"',
          '  tell process "Simulator"',
          '    set winPos to position of window 1',
          '    set wx to item 1 of winPos',
          '    set wy to item 2 of winPos',
          '    return (wx as text) & "," & (wy as text)',
          '  end tell',
          'end tell',
        ]);
        const [fx, fy] = winResult.split(',').map(Number);
        if (isFinite(fx) && isFinite(fy)) {
          winX = fx;
          winY = fy;
        }
      } catch {
        // If even the fallback fails, use 0,0.
      }
      contentX = winX;
      contentY = winY;
    }

    this.originCache.set(deviceId, { x: contentX, y: contentY, winX, winY });
    return { x: contentX, y: contentY };
  }

  /**
   * Translate iOS point coordinates to absolute macOS screen coordinates.
   * Assumes 1:1 point mapping (Simulator at default zoom).
   */
  private async toScreen(
    deviceId: string,
    x: number,
    y: number,
  ): Promise<{ sx: number; sy: number }> {
    const origin = await this.getSimulatorContentOrigin(deviceId);
    return {
      sx: Math.round(origin.x + x),
      sy: Math.round(origin.y + y),
    };
  }

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      await this.activateSimulator();
      const { sx, sy } = await this.toScreen(deviceId, x, y);

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
    });
  }

  async swipe(
    deviceId: string,
    startX: number, startY: number,
    endX: number, endY: number,
    duration?: number,
  ): Promise<void> {
    await timedInput(this.kind, 'swipe', deviceId, async () => {
      await this.activateSimulator();
      // Get origin once for both start and end coordinates
      const origin = await this.getSimulatorContentOrigin(deviceId);
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
    });
  }

  async typeText(deviceId: string, text: string, _delayMs?: number): Promise<void> {
    await timedInput(this.kind, 'typeText', deviceId, async () => {
      await this.activateSimulator();
      // Escape special AppleScript characters
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await this.runAppleScript([
        `tell application "System Events" to keystroke "${escaped}"`,
      ]);
    });
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await timedInput(this.kind, 'keypress', deviceId, async () => {
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
    });
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await timedInput(this.kind, 'sendKey', deviceId, async () => {
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
    });
  }

  /**
   * Batching is not supported on AppleScriptInputBackend. This is the
   * opt-in focus-stealing path; each tap must activate Simulator.app first,
   * so there is no meaningful process-spawn reduction available. Callers
   * that need repeated taps via this backend must invoke `tap()` in a loop.
   */
  supportsBatching(): boolean {
    return false;
  }
}
