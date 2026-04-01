/**
 * TabClient — Per-tab BrowserBackend wrapper.
 *
 * Delegates all operations to the underlying WebKitClient with a pinned targetId,
 * enabling multiple tabs to be controlled independently through the same WebSocket.
 */

import { EventEmitter } from 'events';
import {
  BrowserBackend,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ElementInfo,
  Cookie,
} from '../types/browser-backend';
import { WebKitClient } from '../webkit/client';

export class TabClient extends EventEmitter implements BrowserBackend {
  private _listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private _destroyHandler: (event: { targetId: string }) => void;

  constructor(
    private client: WebKitClient,
    private targetId: string,
  ) {
    super();
    // Forward inner events scoped to this target
    this._destroyHandler = (event: { targetId: string }) => {
      if (event.targetId === this.targetId) {
        this.emit('disconnect');
      }
    };
    this.client.on('target:destroyed', this._destroyHandler);
  }

  /**
   * Remove all listeners registered on the parent WebKitClient.
   * Must be called when the tab is closed to prevent memory leaks.
   */
  destroy(): void {
    this.client.removeListener('target:destroyed', this._destroyHandler);
    for (const { event, handler } of this._listeners) {
      this.client.removeListener(event, handler);
    }
    this._listeners = [];
    this.removeAllListeners();
  }

  getTargetId(): string {
    return this.targetId;
  }

  // ========== Lifecycle ==========

  async connect(): Promise<void> {
    // TabClient reuses the parent WebKitClient's connection — no-op
    if (!this.client.isConnected()) {
      throw new Error('Parent WebKitClient is not connected');
    }
  }

  async disconnect(): Promise<void> {
    // TabClient doesn't own the WebSocket — no-op
    // Tab closure is handled by TabPool
  }

  isConnected(): boolean {
    return this.client.isConnected() && this.client.getKnownTargets().has(this.targetId);
  }

  // ========== Core ==========

  async navigate(options: NavigateOptions): Promise<NavigateResult> {
    const start = Date.now();
    await this.send('Page.navigate', { url: options.url });
    // Wait for load event
    if (options.waitUntil === 'load' || !options.waitUntil) {
      await this.waitForEvent('Page.loadEventFired', options.timeout ?? 30000);
    }
    return { url: options.url, status: 200, loadTime: Date.now() - start };
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    await this.enableDomain('Page');
    const viewport = await this.evaluate<{ w: number; h: number }>(
      '({w: window.innerWidth, h: window.innerHeight})',
    );
    const clip = options?.clip ?? { x: 0, y: 0, width: viewport.w, height: viewport.h };
    const result = await this.send<{ dataURL: string }>('Page.snapshotRect', {
      x: clip.x, y: clip.y, width: clip.width, height: clip.height,
      coordinateSystem: 'Viewport',
    });
    const base64Data = result.dataURL.split(',')[1];
    if (!base64Data) {
      throw new Error('Could not capture snapshot');
    }
    return Buffer.from(base64Data, 'base64');
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    await this.enableDomain('Runtime');
    const result = await this.send<{ result: { value: T }; wasThrown?: boolean; exceptionDetails?: any }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
    );
    if (result.wasThrown) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails ?? result.result)}`);
    }
    return result.result.value;
  }

  async readPage(): Promise<string> {
    return this.evaluate<string>('document.documentElement.outerHTML');
  }

  // ========== Cookies ==========

  async getCookies(domain?: string): Promise<Cookie[]> {
    await this.enableDomain('Page');
    const result = await this.send<{ cookies: Cookie[] }>('Page.getCookies');
    if (domain) {
      return result.cookies.filter(c => c.domain.includes(domain));
    }
    return result.cookies;
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    await this.enableDomain('Page');
    for (const cookie of cookies) {
      await this.send('Page.setCookie', cookie as unknown as Record<string, unknown>);
    }
  }

  async clearCookies(): Promise<void> {
    const cookies = await this.getCookies();
    for (const cookie of cookies) {
      await this.send('Page.deleteCookie', { cookieName: cookie.name, url: `https://${cookie.domain}${cookie.path}` });
    }
  }

  // ========== Interaction ==========

  async click(target: string | { x: number; y: number }): Promise<void> {
    if (typeof target === 'string') {
      const el = await this.querySelector(target);
      if (!el?.boundingBox) throw new Error(`Element not found or not visible: ${target}`);
      const { x, y, width, height } = el.boundingBox;
      await this.simulateTouch(x + width / 2, y + height / 2);
    } else {
      await this.simulateTouch(target.x, target.y);
    }
  }

  async type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    await this.click(selector);
    const delay = options?.delay ?? 50;
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    await this.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
  }

  async longPress(selector: string, duration?: number): Promise<void> {
    const el = await this.querySelector(selector);
    if (!el?.boundingBox) throw new Error(`Element not found: ${selector}`);
    const { x, y, width, height } = el.boundingBox;
    const cx = x + width / 2;
    const cy = y + height / 2;
    await this.evaluate(`
      (function(x, y, dur) {
        var el = document.elementFromPoint(x, y);
        if (!el) return;
        var ts = document.createTouch(window, el, 1, x, y, x, y);
        var tl = document.createTouchList(ts);
        el.dispatchEvent(new TouchEvent('touchstart', { touches: tl, changedTouches: tl, bubbles: true }));
        setTimeout(function() {
          el.dispatchEvent(new TouchEvent('touchend', { touches: document.createTouchList(), changedTouches: tl, bubbles: true }));
        }, dur);
      })(${cx}, ${cy}, ${duration ?? 500})
    `);
    await new Promise(r => setTimeout(r, (duration ?? 500) + 100));
  }

  async swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void> {
    const dist = speed ?? 300;
    const dx = direction === 'left' ? -dist : direction === 'right' ? dist : 0;
    const dy = direction === 'up' ? -dist : direction === 'down' ? dist : 0;
    await this.evaluate(`window.scrollBy(${dx}, ${dy})`);
  }

  async press(key: string): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: key });
  }

  async dismissKeyboard(): Promise<void> {
    await this.evaluate('document.activeElement?.blur()');
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.evaluate(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

  // ========== DOM ==========

  async querySelector(selector: string): Promise<ElementInfo | null> {
    return this.evaluate<ElementInfo | null>(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        return {
          selector: ${JSON.stringify(selector)},
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').substring(0, 200),
          attributes: Object.fromEntries(Array.from(el.attributes).map(function(a) { return [a.name, a.value]; })),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          isVisible: cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        };
      })()
    `);
  }

  async querySelectorAll(selector: string): Promise<ElementInfo[]> {
    return this.evaluate<ElementInfo[]>(`
      Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(function(el) {
        var rect = el.getBoundingClientRect();
        return {
          selector: ${JSON.stringify(selector)},
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').substring(0, 200),
          attributes: Object.fromEntries(Array.from(el.attributes).map(function(a) { return [a.name, a.value]; })),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          isVisible: window.getComputedStyle(el).display !== 'none' && rect.width > 0 && rect.height > 0
        };
      })
    `);
  }

  async inspect(selector: string): Promise<Record<string, unknown>> {
    return this.evaluate<Record<string, unknown>>(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found' };
        var rect = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className,
          text: (el.textContent || '').substring(0, 500),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          styles: { display: cs.display, position: cs.position, zIndex: cs.zIndex, opacity: cs.opacity },
        };
      })()
    `);
  }

  async waitFor(selector: string, options?: { visible?: boolean; timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = await this.querySelector(selector);
      if (el && (!options?.visible || el.isVisible)) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`waitFor: ${selector} not found within ${timeout}ms`);
  }

  // ========== Events ==========

  onConsole(handler: (msg: { type: string; text: string }) => void): void {
    const boundHandler = (params: any, meta?: { targetId?: string }) => {
      if (meta?.targetId && meta.targetId !== this.targetId) return;
      handler({ type: params.type, text: params.args?.map((a: any) => a.value ?? a.description).join(' ') ?? '' });
    };
    this._listeners.push({ event: 'Runtime.consoleAPICalled', handler: boundHandler });
    this.client.on('Runtime.consoleAPICalled', boundHandler);
  }

  onRequest(handler: (request: { url: string; method: string }) => void): void {
    const boundHandler = (params: any, meta?: { targetId?: string }) => {
      if (meta?.targetId && meta.targetId !== this.targetId) return;
      handler({ url: params.request?.url, method: params.request?.method });
    };
    this._listeners.push({ event: 'Network.requestWillBeSent', handler: boundHandler });
    this.client.on('Network.requestWillBeSent', boundHandler);
  }

  onResponse(handler: (response: { url: string; status: number }) => void): void {
    const boundHandler = (params: any, meta?: { targetId?: string }) => {
      if (meta?.targetId && meta.targetId !== this.targetId) return;
      handler({ url: params.response?.url, status: params.response?.status });
    };
    this._listeners.push({ event: 'Network.responseReceived', handler: boundHandler });
    this.client.on('Network.responseReceived', boundHandler);
  }

  // ========== Private Helpers ==========

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.sendToTarget<T>(method, params, this.targetId);
  }

  private async enableDomain(domain: string): Promise<void> {
    await this.client.enableDomainForTarget(domain, this.targetId);
  }

  private async simulateTouch(x: number, y: number): Promise<void> {
    await this.evaluate(`
      (function(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return;
        var ts = document.createTouch(window, el, 1, x, y, x, y);
        var tl = document.createTouchList(ts);
        el.dispatchEvent(new TouchEvent('touchstart', { touches: tl, changedTouches: tl, bubbles: true }));
        el.dispatchEvent(new TouchEvent('touchend', { touches: document.createTouchList(), changedTouches: tl, bubbles: true }));
        el.click();
      })(${x}, ${y})
    `);
  }

  private waitForEvent(eventName: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.removeListener(eventName, handler);
        reject(new Error(`Timeout waiting for ${eventName}`));
      }, timeout);
      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      this.client.once(eventName, handler);
    });
  }
}
