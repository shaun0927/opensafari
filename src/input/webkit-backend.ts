/**
 * WebKitInputBackend — uses WebKit Remote Debugging Protocol (JavaScript touch events).
 *
 * Completely focus-free — communicates over a TCP socket, so the Simulator
 * window does not need to be in the foreground.
 *
 * Limitations:
 *   - Only works when Safari/WebView is connected via WebKit protocol
 *   - Touch events dispatched via JS have `isTrusted: false`, so native
 *     scroll is supplemented with an explicit `window.scrollBy()` call
 *
 * Split from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. Behavior is strictly unchanged.
 */

import type { BrowserBackend } from '../types/browser-backend';
import { timedInput } from '../metrics/input-telemetry';
import {
  buildLongPressScript,
  buildSwipeScript,
} from '../webkit/dom-input-scripts';
import type { InputBackend } from './backend';

/**
 * HID key-code → standard key name mapping for WebKit `press()`.
 */
export const HID_TO_WEBKIT_KEY: Record<string, string> = {
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
export const SENDKEY_TO_WEBKIT_KEY: Record<string, string> = {
  Return: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  Delete: 'Backspace',
  Home: 'Home',
};

/**
 * Uses WebKit Remote Debugging Protocol (JavaScript touch events) for input.
 */
export class WebKitInputBackend implements InputBackend {
  readonly kind = 'webkit' as const;
  constructor(private client: BrowserBackend) {}

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      if (duration && duration > 0) {
        // Long press via touch events with delay
        await this.client.evaluate(
          buildLongPressScript({ x, y, durationMs: duration * 1000 }),
        );
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
      await this.client.evaluate(
        buildSwipeScript({
          startX, startY, endX, endY, steps, stepDelayMs: stepDelay,
          scroll: { scrollX, scrollY },
        }),
      );
    });
  }

  async typeText(deviceId: string, text: string, _delayMs?: number): Promise<void> {
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

  /**
   * Batching is not supported on WebKitInputBackend. JS injection executes
   * in-process over an already-established WebSocket — there is no process
   * spawn overhead to reduce. Each `tap()` call is already near-zero-cost
   * from a spawn perspective.
   */
  supportsBatching(): boolean {
    return false;
  }
}
