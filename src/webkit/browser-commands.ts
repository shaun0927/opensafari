/**
 * browser-commands.ts — High-level browser command implementations for WebKit.
 *
 * Extracted from client.ts (#706 4/5). Behavior-preserving: same protocol calls,
 * same screenshot API (Page.snapshotRect), same touch APIs (document.createTouch),
 * same per-target domain dedup (via TargetSessionManager), same evaluate semantics.
 *
 * Owns:
 *   - navigate, screenshot, click, longPress, swipe, type, scroll, press,
 *     dismissKeyboard, selectOption, readPage, querySelector, querySelectorAll,
 *     inspect, waitFor, getCookies, setCookies, clearCookies
 *
 * Does NOT own: transport lifecycle, target discovery, heartbeat, reconnection,
 *               event forwarding, domain management.
 */

import { EvaluationError, ProtocolError, TimeoutError } from './errors';
import { evaluateValue, type EvaluateSender } from './evaluate';
import {
  buildTapScript,
  buildLongPressScript,
  buildSwipeScript,
  buildSetValueScript,
  buildAppendCharScript,
} from './dom-input-scripts';
import {
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ElementInfo,
  Cookie,
} from '../types/browser-backend';

// ========== Adapter interfaces ==========

/**
 * Minimal adapter interface for BrowserCommands to send protocol commands.
 * Avoids circular dependency on WebKitClient.
 */
export interface BrowserCommandSender {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  enableDomain(domain: string): Promise<void>;
}

// ========== BrowserCommands ==========

export class BrowserCommands {
  constructor(private readonly sender: BrowserCommandSender) {}

  // ========== Evaluate ==========

  /**
   * Evaluate a JS expression in the page context.
   * Handles Promises via a separate Runtime.awaitPromise call (WebKit requirement).
   *
   * Step 1: Runtime.evaluate with returnByValue:false to preserve objectId for Promises.
   *         WebKit serializes Promises as {} when returnByValue:true, losing the
   *         objectId needed for Runtime.awaitPromise.
   * Step 2: If the result is a Promise, use Runtime.awaitPromise to resolve it.
   * Step 3: For non-Promise object results, use Runtime.callFunctionOn to serialize
   *         the value without re-executing the expression (avoids double side effects).
   */
  async evaluate<T = unknown>(
    expression: string,
    options?: { emulateUserGesture?: boolean },
  ): Promise<T> {
    const result = await this.sender.send<{
      result: {
        type: string;
        subtype?: string;
        className?: string;
        value?: unknown;
        objectId?: string;
        description?: string;
      };
      wasThrown: boolean;
    }>('Runtime.evaluate', {
      expression,
      returnByValue: false,
      emulateUserGesture: options?.emulateUserGesture ?? false,
    });

    if (result.wasThrown) {
      throw new EvaluationError(result.result?.description ?? 'Evaluation failed');
    }

    // WebKit Inspector may use subtype:'promise' OR className:'Promise' depending on version
    const isPromise =
      result.result?.type === 'object' &&
      result.result?.objectId &&
      (result.result?.subtype === 'promise' || result.result?.className === 'Promise');

    if (isPromise) {
      // Note: awaitPromise blocks until the Promise settles. Never-resolving Promises
      // will block for the full send() timeout (DEFAULT_WEBKIT_SEND_TIMEOUT_MS, typically 15s).
      const awaited = await this.sender.send<{
        result: { type: string; value?: unknown; objectId?: string; description?: string };
        wasThrown: boolean;
      }>('Runtime.awaitPromise', {
        promiseObjectId: result.result.objectId,
        returnByValue: true,
      });

      if (awaited.wasThrown) {
        throw new EvaluationError(awaited.result?.description ?? 'Promise rejected');
      }
      return awaited.result?.value as T;
    }

    if (result.result?.objectId && result.result?.value === undefined) {
      const valued = await this.sender.send<{
        result: { type: string; value?: unknown; description?: string };
        wasThrown: boolean;
      }>('Runtime.callFunctionOn', {
        objectId: result.result.objectId,
        functionDeclaration: 'function() { return this; }',
        returnByValue: true,
      });
      return valued.result?.value as T;
    }

    return result.result?.value as T;
  }

  // ========== Navigate ==========

  async navigate(options: NavigateOptions, lastUrlSetter?: (url: string) => void): Promise<NavigateResult> {
    const startTime = Date.now();

    if (lastUrlSetter) lastUrlSetter(options.url);

    await this.sender.enableDomain('Page');
    await this.sender.enableDomain('Network');

    // Try Page.navigate first; fall back to JS navigation if unsupported
    try {
      await this.sender.send('Page.navigate', { url: options.url });
    } catch (e) {
      if (e instanceof ProtocolError && e.code === -32601) {
        // Page.navigate not supported — use JS fallback
        await this.evaluate(`window.location.href = ${JSON.stringify(options.url)}`);
      } else {
        throw e;
      }
    }

    // Poll document.readyState instead of relying on Page.loadEventFired
    const waitUntil = options.waitUntil;
    const waitStart = Date.now();
    const navTimeout = options.timeout ?? 30000;
    while (Date.now() - waitStart < navTimeout) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const readyState = await this.evaluate<string>('document.readyState');
        if (waitUntil === 'networkidle') {
          // networkidle not directly detectable via polling
          // Fall back to 'complete' readyState + extra delay
          if (readyState === 'complete') {
            await new Promise(r => setTimeout(r, 500)); // extra settle time
            break;
          }
        } else if (waitUntil === 'domcontentloaded') {
          if (readyState === 'interactive' || readyState === 'complete') break;
        } else if (waitUntil === 'load') {
          if (readyState === 'complete') break;
        } else {
          if (readyState === 'complete') break;
        }
      } catch {
        // Target may be transitioning during navigation, keep polling
        continue;
      }
    }

    // P0-1 + P0-2: Batch final state reads into ONE evaluateValue call (saves 2 extra RPCs).
    // Reads readyState, current URL, and HTTP status together so the navigation path
    // issues exactly one Runtime.evaluate for all three values.
    const navState = await evaluateValue<{ url: string; readyState: string; status: number }>(
      this.sender as EvaluateSender,
      `(function() {
        var rs = document.readyState;
        var url = document.URL;
        var st = 200;
        try { var e = performance.getEntriesByType('navigation')[0]; st = e ? (e.responseStatus || 200) : 200; } catch(ex) {}
        return { url: url, readyState: rs, status: st };
      })()`,
    ).catch(() => ({ url: options.url, readyState: '', status: 200 }));

    const finalReadyState = navState.readyState;
    const currentUrl = navState.url;
    const status = navState.status;

    const expectedState = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    if (finalReadyState !== 'complete' && finalReadyState !== expectedState) {
      throw new TimeoutError(`Navigation timeout after ${navTimeout}ms (readyState: ${finalReadyState})`);
    }

    return {
      url: currentUrl,
      status,
      loadTime: Date.now() - startTime,
    };
  }

  // ========== Screenshot ==========

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    try {
      // Try WebKit Protocol: Page.snapshotRect (NEVER Page.captureScreenshot)
      // Only fetch viewport dimensions when no clip is provided to avoid an extra roundtrip.
      // Uses evaluateValue fast path (returnByValue:true, single RPC — skips the
      // objectId/callFunctionOn round-trip).
      const clip = options?.clip ?? await evaluateValue<{ x: number; y: number; width: number; height: number }>(
        this.sender as EvaluateSender,
        '({x: 0, y: 0, width: window.innerWidth, height: window.innerHeight})',
      );

      const result = await this.sender.send<{ dataURL: string }>('Page.snapshotRect', {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        coordinateSystem: 'Viewport',
      });

      // dataURL format: "data:image/png;base64,..."
      const base64Data = result.dataURL.split(',')[1];
      if (!base64Data) {
        throw new Error('Invalid dataURL from Page.snapshotRect');
      }
      return Buffer.from(base64Data, 'base64');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Screenshot failed: ${reason} — use SimulatorManager.screenshot() as fallback`);
    }
  }

  // ========== Click / Tap ==========

  async click(target: string | { x: number; y: number }): Promise<void> {
    let x: number, y: number;

    if (typeof target === 'string') {
      const center = await this.getElementCenter(target);
      if (!center) throw new Error(`Element not found: ${target}`);
      x = center.x;
      y = center.y;
    } else {
      x = target.x;
      y = target.y;
    }

    // Dispatch touch tap: touchstart → touchend → click
    // Uses document.createTouch for iOS Safari compatibility (new Touch() not supported)
    await this.evaluate(buildTapScript({ x, y }), { emulateUserGesture: true });
  }

  // ========== Long Press ==========

  async longPress(selector: string, duration?: number): Promise<void> {
    const center = await this.getElementCenter(selector);
    if (!center) throw new Error(`Element not found: ${selector}`);
    const dur = duration ?? 500;
    await this.evaluate(
      buildLongPressScript({ x: center.x, y: center.y, durationMs: dur }),
      { emulateUserGesture: true },
    );
  }

  // ========== Swipe ==========

  async swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void> {
    const viewport = await this.getViewportSize();
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    const distance = viewport.height * 0.4;
    const steps = speed ?? 10;

    const coords = {
      up:    { sx: cx, sy: cy + distance / 2, ex: cx, ey: cy - distance / 2 },
      down:  { sx: cx, sy: cy - distance / 2, ex: cx, ey: cy + distance / 2 },
      left:  { sx: cx + distance / 2, sy: cy, ex: cx - distance / 2, ey: cy },
      right: { sx: cx - distance / 2, sy: cy, ex: cx + distance / 2, ey: cy },
    };
    const { sx, sy, ex, ey } = coords[direction];

    await this.evaluate(
      buildSwipeScript({ startX: sx, startY: sy, endX: ex, endY: ey, steps, stepDelayMs: 16 }),
      { emulateUserGesture: true },
    );
  }

  // ========== Type ==========

  async type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    // Focus the element explicitly — touch-based click() doesn't reliably trigger focus.
    // preventScroll prevents iOS Safari from auto-scrolling the element into view on focus.
    const selectorJson = JSON.stringify(selector);
    await this.evaluate(
      `(function() {
        var el = document.querySelector(${selectorJson});
        if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
      })()`,
      { emulateUserGesture: true },
    );

    if (options?.delay) {
      // Character-by-character mode with delay
      for (const char of text) {
        await this.evaluate(
          buildAppendCharScript({ selector, char }),
          { emulateUserGesture: true },
        );
        await new Promise(r => setTimeout(r, options.delay));
      }
    } else {
      // Fast mode: set value directly + dispatch events
      await this.evaluate(
        buildSetValueScript({ selector, value: text, dispatchEvents: 'input-change' }),
        { emulateUserGesture: true },
      );
    }
  }

  // ========== Scroll ==========

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const scrollMap: Record<string, string> = {
      up: `window.scrollBy(0, -${amount})`,
      down: `window.scrollBy(0, ${amount})`,
      left: `window.scrollBy(-${amount}, 0)`,
      right: `window.scrollBy(${amount}, 0)`,
    };
    await this.evaluate(scrollMap[direction]);
  }

  // ========== Press ==========

  async press(key: string): Promise<void> {
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'Space': { key: ' ', code: 'Space', keyCode: 32 },
    };

    const isAlpha = /^[a-zA-Z]$/.test(key);
    const fallbackCode = /^[0-9]$/.test(key)
      ? `Digit${key}`
      : isAlpha
        ? `Key${key.toUpperCase()}`
        : '';
    // For alphabetic keys, `KeyboardEvent.keyCode` on keydown/keyup is the
    // uppercase ASCII value (65-90), independent of shift state. Symbols and
    // digits use the character code directly.
    const fallbackKeyCode = isAlpha ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0);
    const mapped = keyMap[key] ?? { key, code: fallbackCode, keyCode: fallbackKeyCode };
    const keyJson = JSON.stringify(mapped.key);
    const codeJson = JSON.stringify(mapped.code);

    await this.evaluate(`
      (function() {
        var el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ${keyJson}, code: ${codeJson}, keyCode: ${mapped.keyCode}, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ${keyJson}, code: ${codeJson}, keyCode: ${mapped.keyCode}, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ${keyJson}, code: ${codeJson}, keyCode: ${mapped.keyCode}, bubbles: true }));
      })()
    `);
  }

  // ========== Dismiss Keyboard ==========

  async dismissKeyboard(): Promise<void> {
    await this.evaluate('document.activeElement && document.activeElement.blur()');
  }

  // ========== Select Option ==========

  async selectOption(selector: string, value: string): Promise<void> {
    await this.evaluate(
      buildSetValueScript({ selector, value, dispatchEvents: 'input-change' }),
    );
  }

  // ========== Read Page ==========

  async readPage(): Promise<string> {
    return this.evaluate<string>(`
      (function() {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              return node.textContent && node.textContent.trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            }
          }
        );
        const parts = [];
        let node;
        while (node = walker.nextNode()) {
          parts.push(node.textContent.trim());
        }
        return parts.join('\\n');
      })()
    `);
  }

  // ========== Cookies ==========

  async getCookies(domain?: string): Promise<Cookie[]> {
    // Try Page.getCookies first (returns full metadata including httpOnly).
    // Falls back to document.cookie if the proxy doesn't support the command.
    try {
      const result = await this.sender.send<{ cookies: Array<Record<string, unknown>> }>('Page.getCookies');
      if (result?.cookies) {
        // RFC 6265 cookie-host matching: return only cookies that would be sent
        // on a request to `domain`. That is, the cookie's normalized scope
        // either equals `domain` or is a parent of it. Cookies scoped to a
        // subdomain of `domain` are NOT sent to `domain` and are excluded.
        // `another-example.com` is correctly excluded for filter `example.com`.
        const wanted = domain?.replace(/^\./, '');
        const matchesDomain = (cookieDomain: string): boolean => {
          if (!wanted) return true;
          const cd = cookieDomain.replace(/^\./, '');
          if (!cd) return false;
          return cd === wanted || wanted.endsWith(`.${cd}`);
        };
        return result.cookies
          .filter(c => matchesDomain(((c.domain as string) || '')))
          .map(c => ({
            name: (c.name as string) || '',
            value: (c.value as string) || '',
            domain: (c.domain as string) || '',
            path: (c.path as string) || '/',
            expires: typeof c.expires === 'number' ? c.expires : -1,
            httpOnly: !!(c.httpOnly),
            secure: !!(c.secure),
            ...(c.sameSite ? { sameSite: c.sameSite as Cookie['sameSite'] } : {}),
          }));
      }
    } catch {
      // Page.getCookies not supported or proxy crashed — fall back to document.cookie
    }
    const raw = await this.evaluate<string>('document.cookie');
    if (!raw) return [];
    return raw.split(';').map(pair => {
      const [name, ...rest] = pair.trim().split('=');
      return {
        name: name.trim(),
        value: rest.join('='),
        domain: domain ?? '',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
      };
    }).filter(c => c.name);
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    // Try Page.setCookie first (supports httpOnly, sameSite).
    // Falls back to document.cookie if the proxy doesn't support the command.
    for (const cookie of cookies) {
      try {
        await this.sender.send('Page.setCookie', {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || undefined,
          path: cookie.path || '/',
          expires: cookie.expires > 0 ? cookie.expires : undefined,
          httpOnly: cookie.httpOnly || undefined,
          secure: cookie.secure || undefined,
          sameSite: cookie.sameSite || undefined,
        });
      } catch {
        // Page.setCookie not supported — fall back to document.cookie
        const parts = [`${cookie.name}=${cookie.value}`];
        if (cookie.path) parts.push(`path=${cookie.path}`);
        if (cookie.domain) parts.push(`domain=${cookie.domain}`);
        if (cookie.secure) parts.push('secure');
        if (cookie.expires && cookie.expires > 0) {
          parts.push(`expires=${new Date(cookie.expires * 1000).toUTCString()}`);
        }
        await this.evaluate(`document.cookie = ${JSON.stringify(parts.join('; '))}`);
      }
    }
  }

  async clearCookies(): Promise<void> {
    // Try Page.deleteCookie for each cookie (handles httpOnly).
    // Falls back to document.cookie clearing if not supported.
    try {
      const cookies = await this.getCookies();
      let processed = 0;
      for (const cookie of cookies) {
        // Strip leading dot from cookie domain — `.example.com` is a valid cookie
        // domain but `https://.example.com/` is not a valid URL and Page.deleteCookie
        // rejects it. Skip empty domains; they can occur on the document.cookie
        // fallback path and would produce `https:///path`.
        const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        if (!host) continue;
        await this.sender.send('Page.deleteCookie', {
          cookieName: cookie.name,
          url: `https://${host}${cookie.path}`,
        });
        processed += 1;
      }
      // If there were cookies to delete but none had a usable domain (the
      // document.cookie fallback path), fall through to JS-based clearing
      // instead of returning silently with nothing deleted.
      if (cookies.length === 0 || processed > 0) return;
    } catch {
      // Page.deleteCookie not supported — fall back
    }
    await this.evaluate(`
      document.cookie.split(';').forEach(function(c) {
        var name = c.trim().split('=')[0];
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      });
    `);
  }

  // ========== DOM Queries ==========

  async querySelector(selector: string): Promise<ElementInfo | null> {
    return this.evaluate<ElementInfo | null>(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return {
          selector: ${JSON.stringify(selector)},
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, 200),
          attributes: Object.fromEntries(Array.from(el.attributes).map(function(a) { return [a.name, a.value]; })),
          boundingBox: rect.width > 0 && rect.height > 0
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
          computedStyles: {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            fontSize: style.fontSize,
            color: style.color,
            backgroundColor: style.backgroundColor,
            position: style.position,
            zIndex: style.zIndex,
            overflow: style.overflow
          },
          isVisible: rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && parseFloat(style.opacity) > 0
        };
      })()
    `);
  }

  async querySelectorAll(selector: string): Promise<ElementInfo[]> {
    return this.evaluate<ElementInfo[]>(`
      (function() {
        var elements = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(elements).slice(0, 100).map(function(el) {
          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return {
            selector: ${JSON.stringify(selector)},
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().substring(0, 200),
            attributes: Object.fromEntries(Array.from(el.attributes).map(function(a) { return [a.name, a.value]; })),
            boundingBox: rect.width > 0 && rect.height > 0
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
            computedStyles: {
              display: style.display, visibility: style.visibility, opacity: style.opacity,
              fontSize: style.fontSize, position: style.position
            },
            isVisible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0
          };
        });
      })()
    `);
  }

  async inspect(selector: string): Promise<Record<string, unknown>> {
    return this.evaluate<Record<string, unknown>>(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className,
          text: (el.textContent || '').trim().substring(0, 500),
          innerHTML: el.innerHTML.substring(0, 1000),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          styles: {
            display: style.display, position: style.position,
            width: style.width, height: style.height,
            margin: style.margin, padding: style.padding,
            fontSize: style.fontSize, fontWeight: style.fontWeight,
            color: style.color, backgroundColor: style.backgroundColor,
            border: style.border, borderRadius: style.borderRadius,
            overflow: style.overflow, zIndex: style.zIndex,
            opacity: style.opacity, visibility: style.visibility
          },
          accessibility: {
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            ariaHidden: el.getAttribute('aria-hidden'),
            tabIndex: el.tabIndex
          },
          childCount: el.children.length,
          children: Array.from(el.children).slice(0, 10).map(function(c) {
            return { tag: c.tagName.toLowerCase(), text: (c.textContent || '').trim().substring(0, 50) };
          })
        };
      })()
    `);
  }

  // ========== Wait For ==========

  async waitFor(selector: string, options?: { visible?: boolean; timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 10000;
    const interval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const el = await this.querySelector(selector);
      if (el && (!options?.visible || el.isVisible)) return;
      await new Promise(r => setTimeout(r, interval));
    }

    throw new TimeoutError(`waitFor("${selector}") timed out after ${timeout}ms`);
  }

  // ========== Private helpers ==========

  private async getElementCenter(selector: string): Promise<{ x: number; y: number } | null> {
    return this.evaluate<{ x: number; y: number } | null>(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `);
  }

  private async getViewportSize(): Promise<{ width: number; height: number }> {
    return this.evaluate<{ width: number; height: number }>(
      '({width: window.innerWidth, height: window.innerHeight})',
    );
  }
}
