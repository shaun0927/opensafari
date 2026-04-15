/**
 * NativeInputBackend — Abstraction layer for sending input events to iOS Simulator.
 *
 * Provides three backends (selected via auto-detection):
 *   1. SimctlInputBackend   — `xcrun simctl io <device> input` (Xcode 15–16)
 *   2. WebKitInputBackend   — JavaScript touch events via WebKit protocol (Xcode 26+, Safari)
 *   3. AppleScriptInputBackend — osascript + CGEvent (opt-in only, requires window focus)
 *
 * On Xcode 26+ where `simctl io input` was removed, the WebKit backend provides
 * focus-free touch injection for Safari web content.
 *
 * The AppleScript backend is **default-deny**: it is only instantiated when the
 * caller explicitly opts in via the `OPENSAFARI_ALLOW_FOCUS_INPUT=1` environment
 * variable. Without the opt-in, `getInputBackend()` throws
 * `HeadlessInputUnavailableError` with actionable remediation guidance. This
 * prevents the surprising focus-theft / mouse-movement behavior that motivated
 * issues #403 and #405.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimctlExecutor } from '../simulator/simctl';
import type { BrowserBackend } from '../types/browser-backend';
import type { FlutterVMClient } from '../flutter';
import { getFlutterVMClient } from '../flutter';
import { FlutterVMInputBackend } from './flutter-vm-input-backend';
import { tryCreateSimulatorKitHIDBackend } from './sim-hid-input-backend';
import { timedInput } from '../metrics/input-telemetry';

const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Stable identifier for each concrete input backend. Included in tool call
 * results so MCP clients and users can audit which path dispatched their
 * input — useful when diagnosing focus-theft reports or confirming that a
 * call stayed on a headless tier.
 */
export type InputBackendKind = 'flutter-vm' | 'simctl' | 'webkit' | 'applescript' | 'simhid';

export interface InputBackend {
  /** Stable identifier used for observability / audit logging. */
  readonly kind: InputBackendKind;

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
  readonly kind = 'simctl' as const;
  private simctl: SimctlExecutor;

  constructor(simctl?: SimctlExecutor) {
    this.simctl = simctl ?? new SimctlExecutor();
  }

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      if (duration && duration > 0) {
        await this.simctl.exec([
          'io', deviceId, 'input', 'press',
          String(x), String(y), String(duration),
        ]);
      } else {
        await this.simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
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
    });
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await timedInput(this.kind, 'typeText', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'input', 'text', text]);
    });
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await timedInput(this.kind, 'keypress', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'input', 'keypress', keyCode]);
    });
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await timedInput(this.kind, 'sendKey', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'sendkey', keyName]);
    });
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
  readonly kind = 'applescript' as const;

  /**
   * Per-device cache for the resolved content origin.
   * Key: deviceId, Value: { x, y, winX, winY } where winX/winY is the window
   * top-left at the time of the last measurement (used to detect window moves).
   */
  private originCache = new Map<string, { x: number; y: number; winX: number; winY: number }>();

  /** Set of deviceIds that have already emitted the AX fallback warning. */
  private warnedDevices = new Set<string>();

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
   *
   * Uses the cached origin from `getSimulatorContentOrigin`. If the user
   * moves the window or rotates the device, callers must explicitly invalidate
   * the cache via `getSimulatorContentOrigin(deviceId, { refresh: true })`.
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

  async typeText(deviceId: string, text: string): Promise<void> {
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
}

// ── WebKitInputBackend ──────────────────────────────────────────────────

/**
 * HID key-code → standard key name mapping for WebKit `press()`.
 */
const HID_TO_WEBKIT_KEY: Record<string, string> = {
  '40': 'Enter',
  '41': 'Escape',
  '42': 'Backspace',
  '43': 'Tab',
  '44': 'Space',
  '74': 'Home',
  '79': 'ArrowRight',
  '80': 'ArrowLeft',
  '81': 'ArrowDown',
  '82': 'ArrowUp',
};

/**
 * Named key → WebKit `press()` key name mapping.
 */
const SENDKEY_TO_WEBKIT_KEY: Record<string, string> = {
  Return: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  Delete: 'Backspace',
  Home: 'Home',
};

/**
 * Uses WebKit Remote Debugging Protocol (JavaScript touch events) for input.
 * Completely focus-free — communicates over a TCP socket, so the Simulator
 * window does not need to be in the foreground.
 *
 * Limitations:
 *   - Only works when Safari/WebView is connected via WebKit protocol
 *   - Touch events dispatched via JS have `isTrusted: false`, so native
 *     scroll is supplemented with an explicit `window.scrollBy()` call
 */
export class WebKitInputBackend implements InputBackend {
  readonly kind = 'webkit' as const;
  constructor(private client: BrowserBackend) {}

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      if (duration && duration > 0) {
        // Long press via touch events with delay
        await this.client.evaluate(`
          (async function(x, y, duration) {
            var el = document.elementFromPoint(x, y);
            if (!el) return;
            var touch = document.createTouch(window, el, 1, x, y, x, y);
            var touchList = document.createTouchList(touch);
            el.dispatchEvent(new TouchEvent('touchstart', { touches: touchList, changedTouches: touchList, bubbles: true }));
            await new Promise(function(r) { setTimeout(r, duration); });
            var emptyList = document.createTouchList();
            el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: touchList, bubbles: true }));
          })(${x}, ${y}, ${duration * 1000})
        `);
      } else {
        // Normal tap — delegate to BrowserBackend.click() which dispatches
        // touchstart → touchend → click with emulateUserGesture
        await this.client.click({ x, y });
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
      const scrollX = startX - endX;
      const scrollY = startY - endY;
      const steps = 20;
      const stepDelay = ((duration ?? 0.5) * 1000) / steps;

      // Two-pronged: window.scrollBy for native scroll + touch events for JS handlers
      await this.client.evaluate(`
        (async function(sx, sy, ex, ey, scrollX, scrollY, steps, stepDelay) {
          window.scrollBy(scrollX, scrollY);

          var el = document.elementFromPoint(sx, sy);
          if (!el) el = document.body;
          var makeTouch = function(x, y) { return document.createTouch(window, el, 1, x, y, x, y); };
          var startTouch = makeTouch(sx, sy);
          var startList = document.createTouchList(startTouch);
          el.dispatchEvent(new TouchEvent('touchstart', { touches: startList, changedTouches: startList, bubbles: true }));
          for (var i = 1; i <= steps; i++) {
            var x = sx + (ex - sx) * (i / steps);
            var y = sy + (ey - sy) * (i / steps);
            var moveTouch = makeTouch(x, y);
            var moveList = document.createTouchList(moveTouch);
            el.dispatchEvent(new TouchEvent('touchmove', { touches: moveList, changedTouches: moveList, bubbles: true }));
            await new Promise(function(r) { setTimeout(r, stepDelay); });
          }
          var endTouch = makeTouch(ex, ey);
          var endList = document.createTouchList(endTouch);
          var emptyList = document.createTouchList();
          el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: endList, bubbles: true }));
        })(${startX}, ${startY}, ${endX}, ${endY}, ${scrollX}, ${scrollY}, ${steps}, ${stepDelay})
      `);
    });
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await timedInput(this.kind, 'typeText', deviceId, async () => {
      const escaped = JSON.stringify(text);
      await this.client.evaluate(`
        (function() {
          var el = document.activeElement;
          if (!el || el === document.body) return;
          var p = Object.getPrototypeOf(el);
          while (p && !Object.getOwnPropertyDescriptor(p, 'value')) {
            p = Object.getPrototypeOf(p);
          }
          var desc = p ? Object.getOwnPropertyDescriptor(p, 'value') : null;
          var cur = (desc && desc.get) ? desc.get.call(el) : (el.value || '');
          if (desc && desc.set) {
            desc.set.call(el, cur + ${escaped});
          } else if ('value' in el) {
            el.value = cur + ${escaped};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
    });
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await timedInput(this.kind, 'keypress', deviceId, async () => {
      const keyName = HID_TO_WEBKIT_KEY[keyCode];
      if (!keyName) {
        throw new Error(
          `Unknown HID key code "${keyCode}" for WebKit backend. ` +
          `Supported: ${Object.keys(HID_TO_WEBKIT_KEY).join(', ')}`,
        );
      }
      await this.client.press(keyName);
    });
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await timedInput(this.kind, 'sendKey', deviceId, async () => {
      const mapped = SENDKEY_TO_WEBKIT_KEY[keyName] ?? keyName;
      await this.client.press(mapped);
    });
  }
}

// ── HeadlessInputUnavailableError ────────────────────────────────────────────

/**
 * Environment variable that opts in to the focus-stealing AppleScript / CGEvent
 * input backend. When unset (the default), `getInputBackend()` refuses to
 * instantiate `AppleScriptInputBackend` and throws `HeadlessInputUnavailableError`
 * instead, preventing silent focus theft.
 */
export const OPENSAFARI_ALLOW_FOCUS_INPUT_ENV = 'OPENSAFARI_ALLOW_FOCUS_INPUT';
export const OPENSAFARI_HEADLESS_ONLY_ENV = 'OPENSAFARI_HEADLESS_ONLY';

function isFocusInputAllowed(): boolean {
  const value = process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV];
  return value === '1' || value === 'true';
}

function isHeadlessOnly(): boolean {
  const value = process.env[OPENSAFARI_HEADLESS_ONLY_ENV];
  return value === '1' || value === 'true';
}

/**
 * Thrown by `getInputBackend()` when no headless input method is available and
 * the caller has not opted in to the focus-stealing fallback. The error carries
 * structured fields so MCP clients can surface actionable remediation to users
 * without parsing the human-readable message.
 */
export class HeadlessInputUnavailableError extends Error {
  readonly name = 'HeadlessInputUnavailableError' as const;
  readonly deviceId: string;
  readonly reason: 'no-simctl' | 'no-webkit' | 'webkit-disconnected' | 'headless-only';
  readonly remediation: readonly string[];

  constructor(
    deviceId: string,
    reason: HeadlessInputUnavailableError['reason'],
  ) {
    const remediation =
      reason === 'headless-only'
        ? ([
            `${OPENSAFARI_HEADLESS_ONLY_ENV}=1 is set — AppleScript/CGEvent fallback is blocked.`,
            'Ensure a headless backend (simctl, webkit, flutter-vm, simhid) is available.',
            `To allow focus-stealing input, unset ${OPENSAFARI_HEADLESS_ONLY_ENV}.`,
          ] as const)
        : ([
            "Safari QA: call `set_active_context({ context: 'safari' })` to enable WebKitInputBackend",
            `Native apps: opt in to the CGEvent fallback by setting ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV}=1 ` +
              '(WARNING: will move the mouse cursor and bring Simulator.app to the foreground)',
          ] as const);
    const message =
      `No headless input backend available for device ${deviceId} (reason: ${reason}).\n` +
      remediation.map((line) => `  - ${line}`).join('\n');
    super(message);
    this.deviceId = deviceId;
    this.reason = reason;
    this.remediation = remediation;
    // Preserve prototype chain across the TypeScript down-compile
    Object.setPrototypeOf(this, HeadlessInputUnavailableError.prototype);
  }
}

// ── Backend detection & singleton ────────────────────────────────────────────

let simctlAvailable: boolean | null = null;
let detectionPromise: Promise<boolean> | null = null;
let cachedSimctlBackend: SimctlInputBackend | null = null;
let cachedAppleScriptBackend: AppleScriptInputBackend | null = null;
let focusInputOptInWarned = false;

// SimulatorKit HID backend cache (Tier 1)
let simHidProbed = false;
let cachedSimHidBackend: InputBackend | null = null;

// Per-device cache of the Flutter VM client connection so subsequent Tier-0
// lookups reuse an already-established WebSocket instead of re-running
// discovery on every call. Cleared via `resetInputBackend()`.
//
// Value semantics:
//   - FlutterVMClient: positive hit (Flutter app connected; reuse)
//   - null: negative hit (discovery already failed within NEGATIVE_CACHE_TTL_MS;
//     skip discovery and let the caller fall through to Tier 1-3)
interface FlutterClientCacheEntry {
  client: FlutterVMClient | null;
  expiresAt: number;
}
const flutterClientCache = new Map<string, FlutterClientCacheEntry>();

// Negative cache TTL: after a failed discovery, don't re-probe for this long.
// Native iOS apps, Safari, and any simulator without a Flutter debug build
// would otherwise pay the full discovery cost on every `getInputBackend()`
// call, stalling tools like `app_scroll_native` / `app_tap` well past their
// unit-test timeouts.
const NEGATIVE_CACHE_TTL_MS = 30_000;

// Upper bound on how long the initial VM-discovery probe is allowed to block.
// If discovery has not produced a connected client within this window, treat
// the device as non-Flutter so native-app code paths aren't penalised.
const DISCOVERY_TIMEOUT_MS = 1_500;

/**
 * Overridable resolver that returns a connected `FlutterVMClient` for the
 * device, or `null` when no Flutter VM is discoverable (native app, Safari,
 * simulator without Flutter debug build). The default implementation is
 * swapped out by unit tests via `__setFlutterVMResolverForTest`.
 */
type FlutterVMResolver = (deviceId: string) => Promise<FlutterVMClient | null>;

async function defaultFlutterVMResolver(
  deviceId: string,
): Promise<FlutterVMClient | null> {
  const now = Date.now();
  const cached = flutterClientCache.get(deviceId);
  if (cached && cached.expiresAt > now) {
    // Fast path: cached positive hit that is still connected.
    if (cached.client && cached.client.isConnected()) {
      return cached.client;
    }
    // Fast path: cached negative hit within TTL.
    if (cached.client === null) {
      return null;
    }
    // Stale positive entry (client disconnected). Fall through to re-probe.
  }

  // Bound the discovery probe so non-Flutter devices don't stall tools
  // that legitimately just want Tier 1-3.
  try {
    const client = getFlutterVMClient(deviceId);
    if (!client.isConnected()) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('flutter-vm-discovery-timeout')),
          DISCOVERY_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([client.connect({ deviceId }), timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    if (!client.isConnected()) {
      flutterClientCache.set(deviceId, {
        client: null,
        expiresAt: now + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    flutterClientCache.set(deviceId, { client, expiresAt: Infinity });
    return client;
  } catch {
    // VM discovery / connect failures are expected for non-Flutter apps.
    // Cache the negative result so the next call doesn't pay the probe cost.
    flutterClientCache.set(deviceId, {
      client: null,
      expiresAt: now + NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

let flutterVMResolver: FlutterVMResolver = defaultFlutterVMResolver;

/**
 * Attempt to resolve a FlutterVMClient for this device. Returns null whenever
 * the device is not running a Flutter app in debug/profile mode. Never
 * throws — VM discovery errors collapse to null so the tier fallback keeps
 * working for native iOS apps.
 *
 * Exposed so callers (e.g. routing diagnostics) can probe availability
 * without spinning up the backend; the public routing in `getInputBackend()`
 * is the normal entry point.
 */
export async function tryGetFlutterVMClient(
  deviceId: string,
): Promise<FlutterVMClient | null> {
  try {
    return await flutterVMResolver(deviceId);
  } catch {
    return null;
  }
}

/**
 * Test seam: override the Flutter VM resolver. `null` restores the default.
 * Only used by unit tests — mocking `getFlutterVMClient` module-wide is
 * awkward because the singleton map lives inside the module.
 */
export function __setFlutterVMResolverForTest(
  resolver: FlutterVMResolver | null,
): void {
  flutterVMResolver = resolver ?? defaultFlutterVMResolver;
}
/**
 * Probe whether `simctl io input` is available by attempting a no-op tap at (0,0).
 * On Xcode 26+ this subcommand was removed and returns exit code 117.
 */
async function probeSimctlInput(deviceId: string): Promise<boolean> {
  const simctl = new SimctlExecutor();
  try {
    await simctl.exec(['io', deviceId, 'input', 'tap', '0', '0'], { timeout: 5000 });
    return true;
  } catch {
    console.error(
      '[input-backend] simctl io input unavailable (likely Xcode 26+ where this subcommand was removed)',
    );
    return false;
  }
}

/**
 * Attempt a single WebKit reconnect for a client that exists but reports
 * `isConnected() === false`. Returns true if the client is usable after the
 * attempt. Never throws — transient failures fall through to Tier 3.
 */
async function tryReconnectWebKit(client: BrowserBackend): Promise<boolean> {
  try {
    await client.connect();
    return client.isConnected();
  } catch (err) {
    console.error(
      `[input-backend] WebKit reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Get the input backend using a 4-tier fallback strategy with default-deny
 * hardening for the focus-stealing path:
 *
 *   1. **SimulatorKitHIDInputBackend** — SimulatorKit private API (headless,
 *      any app, all Xcode versions). Uses `sim-hid-bridge` Swift helper.
 *   2. **SimctlInputBackend** — `simctl io input` (headless, any app, Xcode ≤16)
 *   3. **WebKitInputBackend** — JS touch events via WebKit protocol (headless,
 *      Safari only). If the supplied client exists but reports disconnected,
 *      one reconnect attempt is made before giving up.
 *   4. **AppleScriptInputBackend** — CGEvent mouse synthesis, requires
 *      Simulator window focus. **Default-deny**: only instantiated when
 *      `OPENSAFARI_ALLOW_FOCUS_INPUT=1` (or `true`) is set in the environment.
 *      Without opt-in, this function throws `HeadlessInputUnavailableError`
 *      instead of silently stealing focus.
 *
 * The simctl probe result is cached for the process lifetime. WebKit
 * availability is checked on each call (connection state can change).
 *
 * @param deviceId      Simulator UDID
 * @param webkitClient  Optional WebKit/Safari connection for Tier 2
 * @throws {HeadlessInputUnavailableError} When no headless method is available
 *         and `OPENSAFARI_ALLOW_FOCUS_INPUT` is not set
 */
export async function getInputBackend(
  deviceId: string,
  webkitClient?: BrowserBackend | null,
): Promise<InputBackend> {
  // Tier 0: Flutter VM Service (headless, no focus stealing, no opt-in).
  // When the target device is running a Flutter app in debug/profile mode we
  // can inject pointer events directly into the Dart isolate, completely
  // bypassing OS-level input. Returns null for native iOS apps and silently
  // falls through to the existing tiers in that case.
  const flutterClient = await tryGetFlutterVMClient(deviceId);
  if (flutterClient) {
    return new FlutterVMInputBackend(flutterClient);
  }

  // Probe simctl once and cache the result
  if (simctlAvailable === null) {
    if (!detectionPromise) {
      detectionPromise = probeSimctlInput(deviceId).then((available) => {
        simctlAvailable = available;
        return available;
      });
    }
    await detectionPromise;
  }

  // Tier 1: SimulatorKit HID (headless, works with any app — all Xcode versions)
  if (!simHidProbed) {
    simHidProbed = true;
    try {
      cachedSimHidBackend = await tryCreateSimulatorKitHIDBackend();
    } catch {
      cachedSimHidBackend = null;
    }
  }
  // SimHID tap/swipe broken on Xcode 26+ (locks screen). TODO(#491): re-enable.
  // if (cachedSimHidBackend) {
  //   return cachedSimHidBackend;
  // }

  // Tier 2: simctl io input (headless, works with any app — Xcode ≤16)
  if (simctlAvailable) {
    if (!cachedSimctlBackend) {
      cachedSimctlBackend = new SimctlInputBackend();
    }
    return cachedSimctlBackend;
  }

  // Tier 2: WebKit JS touch injection (headless, Safari web content only).
  // If the client is present but disconnected, try a one-shot reconnect so
  // transient drops (proxy restart, tab churn) do not flip us to Tier 3.
  if (webkitClient) {
    if (webkitClient.isConnected()) {
      return new WebKitInputBackend(webkitClient);
    }
    const reconnected = await tryReconnectWebKit(webkitClient);
    if (reconnected) {
      return new WebKitInputBackend(webkitClient);
    }
  }

  // HEADLESS_ONLY safety net — block AppleScript fallback even if opt-in is set.
  // This is the CI safety net: when OPENSAFARI_HEADLESS_ONLY=1, any attempt to
  // fall through to the focus-stealing backend is a hard error.
  if (isHeadlessOnly()) {
    if (isFocusInputAllowed()) {
      console.error(
        `[input-backend] ${OPENSAFARI_HEADLESS_ONLY_ENV}=1 overrides ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV} — AppleScript backend disabled`,
      );
    }
    const reason: HeadlessInputUnavailableError['reason'] = 'headless-only';
    const err = new HeadlessInputUnavailableError(deviceId, reason);
    console.error(`[input-backend] ${err.message}`);
    throw err;
  }

  // Tier 3: AppleScript/CGEvent fallback — DEFAULT-DENY.
  // Without explicit opt-in, refuse to return a backend that would move the
  // mouse cursor or steal Simulator focus. See issue #405.
  if (!isFocusInputAllowed()) {
    const reason: HeadlessInputUnavailableError['reason'] = !webkitClient
      ? 'no-webkit'
      : 'webkit-disconnected';
    const err = new HeadlessInputUnavailableError(deviceId, reason);
    console.error(`[input-backend] ${err.message}`);
    throw err;
  }

  if (!focusInputOptInWarned) {
    console.error(
      `[input-backend] ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV}=1 is set — ` +
        'AppleScript/CGEvent backend is enabled. ' +
        'This will move the physical mouse cursor and activate Simulator.app.',
    );
    focusInputOptInWarned = true;
  }

  if (!cachedAppleScriptBackend) {
    cachedAppleScriptBackend = new AppleScriptInputBackend();
  }
  return cachedAppleScriptBackend;
}

/** Reset the cached backend state. Exported for testing only. */
export function resetInputBackend(): void {
  simctlAvailable = null;
  detectionPromise = null;
  cachedSimctlBackend = null;
  cachedAppleScriptBackend = null;
  focusInputOptInWarned = false;
  flutterClientCache.clear();
  flutterVMResolver = defaultFlutterVMResolver;
  simHidProbed = false;
  cachedSimHidBackend = null;
}

// Re-export for convenience
export { HID_TO_APPLESCRIPT, SENDKEY_TO_APPLESCRIPT, HID_TO_WEBKIT_KEY, SENDKEY_TO_WEBKIT_KEY };
