import WebSocket from 'ws';
import http from 'http';
import { EventEmitter } from 'events';
import {
  BrowserBackend,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ElementInfo,
  Cookie,
} from '../types/browser-backend';
import {
  DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS,
  DEFAULT_WEBKIT_SEND_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RECONNECT_MAX_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
} from '../config/defaults';

export interface WebKitClientOptions {
  host: string;
  port: number;
  targetIndex?: number;
  connectTimeout?: number;
  sendTimeout?: number;
  heartbeatInterval?: number;
}

export interface WebKitTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type?: string;
}

export class WebKitClient extends EventEmitter implements BrowserBackend {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private enabledDomains: Set<string> = new Set();
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastUrl: string = '';
  private reconnecting = false;

  // Target-multiplexed protocol state
  private activeTargetId: string | null = null;
  private innerMessageId = 0;
  private innerPendingRequests: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private targetReady: Promise<void> | null = null;
  private targetReadyResolve: (() => void) | null = null;

  constructor(private options: WebKitClientOptions) {
    super();
  }

  // ========== Lifecycle ==========

  async connect(): Promise<void> {
    const targets = await this.listTargets();
    const targetIndex = this.options.targetIndex ?? 0;

    if (targets.length === 0) {
      throw new ConnectionError(
        'No Safari targets found. Is Safari open in the simulator?',
      );
    }

    const target = targets[Math.min(targetIndex, targets.length - 1)];
    await this.connectToTarget(target.webSocketDebuggerUrl);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.clearPendingRequests();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.connected = false;
    this.enabledDomains.clear();
    this.activeTargetId = null;
    this.targetReady = null;
    this.targetReadyResolve = null;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ========== Target Discovery ==========

  async listTargets(): Promise<WebKitTarget[]> {
    const url = `http://${this.options.host}:${this.options.port}/json`;
    const json = await this.httpGet(url);
    return JSON.parse(json) as WebKitTarget[];
  }

  // ========== Protocol Message Layer ==========

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError('WebSocket not connected');
    }
    if (!this.activeTargetId) {
      throw new ConnectionError(
        'No active target. Is Safari open in the simulator?',
      );
    }

    const innerId = ++this.innerMessageId;
    const outerId = ++this.messageId;
    const timeout =
      this.options.sendTimeout ?? DEFAULT_WEBKIT_SEND_TIMEOUT_MS;

    const innerPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.innerPendingRequests.delete(innerId);
        reject(new TimeoutError(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.innerPendingRequests.set(innerId, { resolve, reject, timer });
    });

    // Track outer message for error propagation (e.g., invalid targetId)
    const outerTimer = setTimeout(() => {
      this.pendingRequests.delete(outerId);
    }, timeout);
    this.pendingRequests.set(outerId, {
      resolve: () => { /* outer ack ignored — real response via dispatchMessageFromTarget */ },
      reject: (err: Error) => {
        // Outer error means inner will never resolve — reject inner too
        const innerPending = this.innerPendingRequests.get(innerId);
        if (innerPending) {
          clearTimeout(innerPending.timer);
          this.innerPendingRequests.delete(innerId);
          innerPending.reject(err);
        }
      },
      timer: outerTimer,
    });

    // Wrap in Target.sendMessageToTarget
    const innerMessage = JSON.stringify({ id: innerId, method, params });
    this.ws.send(
      JSON.stringify({
        id: outerId,
        method: 'Target.sendMessageToTarget',
        params: { targetId: this.activeTargetId, message: innerMessage },
      }),
    );

    return innerPromise;
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Handle Target events (multiplexing protocol)
    if (msg.method === 'Target.targetCreated') {
      const info = msg.params?.targetInfo;
      if (info?.type === 'page') {
        // Always track the latest page target
        // If old target still exists, it will be destroyed shortly
        this.activeTargetId = info.targetId;
        // Re-enable domains on new target (e.g., after navigation destroys old target)
        const domains = [...this.enabledDomains];
        this.enabledDomains.clear();
        // Re-enable domains then signal target readiness
        Promise.all(
          domains.map(domain => this.enableDomain(domain).catch(err => {
            console.error(`[WebKitClient] Failed to re-enable ${domain} on new target: ${(err as Error).message}`);
          }))
        ).then(() => {
          this.targetReadyResolve?.();
        });
        return;  // Don't call targetReadyResolve here, wait for domains
      }
      return;
    }

    if (msg.method === 'Target.targetDestroyed') {
      if (msg.params?.targetId === this.activeTargetId) {
        this.activeTargetId = null;
      }
      return;
    }

    if (msg.method === 'Target.dispatchMessageFromTarget') {
      // This contains the REAL response to our domain commands
      let innerMsg: any;
      try {
        innerMsg = JSON.parse(msg.params.message);
      } catch {
        return;
      }
      if (innerMsg.id !== undefined) {
        const pending = this.innerPendingRequests.get(innerMsg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.innerPendingRequests.delete(innerMsg.id);
          if (innerMsg.error) {
            pending.reject(
              new ProtocolError(
                innerMsg.error.message ?? JSON.stringify(innerMsg.error),
                innerMsg.error.code,
              ),
            );
          } else {
            pending.resolve(innerMsg.result);
          }
        }
      } else if (innerMsg.method) {
        // Inner event (e.g., Page.loadEventFired, Runtime.consoleAPICalled)
        this.emit(innerMsg.method, innerMsg.params);
      }
      return;
    }

    if (msg.id !== undefined) {
      // Outer ack response to Target.sendMessageToTarget — just clean up
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        // Don't resolve/reject caller — real response comes via dispatchMessageFromTarget
        // But if there's an outer error (e.g., invalid targetId), propagate it
        if (msg.error) {
          pending.reject(
            new ProtocolError(
              msg.error.message ?? JSON.stringify(msg.error),
              msg.error.code,
            ),
          );
        }
      }
    } else if (msg.method) {
      // Other event notifications not handled above
      this.emit(msg.method, msg.params);
    }
  }

  // ========== Domain Management ==========

  async enableDomain(domain: string): Promise<void> {
    if (!this.enabledDomains.has(domain)) {
      await this.send(`${domain}.enable`);
      this.enabledDomains.add(domain);
    }
  }

  // ========== Heartbeat ==========

  private startHeartbeat(): void {
    const interval =
      this.options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.send('Runtime.evaluate', { expression: '1' });
      } catch {
        this.handleDisconnect();
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ========== Reconnection ==========

  private async handleDisconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;

    // Clear stale inner requests before reconnect
    for (const [, pending] of this.innerPendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionError('Connection lost during reconnect'));
    }
    this.innerPendingRequests.clear();
    this.activeTargetId = null;

    this.stopHeartbeat();

    let attempt = 0;
    const maxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS;

    while (attempt < maxAttempts) {
      attempt++;
      const delay = Math.min(
        DEFAULT_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        DEFAULT_RECONNECT_MAX_DELAY_MS,
      );

      console.error(
        `[WebKitClient] Reconnection attempt ${attempt}/${maxAttempts} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));

      try {
        await this.connect();
        console.error(`[WebKitClient] Reconnected successfully`);

        // Re-enable domains
        const domains = [...this.enabledDomains];
        this.enabledDomains.clear();
        for (const domain of domains) {
          await this.enableDomain(domain);
        }

        // Re-navigate to last URL
        if (this.lastUrl) {
          await this.navigate({ url: this.lastUrl });
        }

        this.reconnecting = false;
        this.emit('reconnected');
        return;
      } catch {
        // Continue retrying
      }
    }

    this.reconnecting = false;
    this.emit('disconnect');
    console.error(
      `[WebKitClient] Failed to reconnect after ${maxAttempts} attempts`,
    );
  }

  // ========== BrowserBackend Implementation (stubs for Epic 1B.2-1B.5) ==========

  async navigate(options: NavigateOptions): Promise<NavigateResult> {
    const startTime = Date.now();
    this.lastUrl = options.url;

    await this.enableDomain('Page');
    await this.enableDomain('Network');

    // Try Page.navigate first; fall back to JS navigation if unsupported
    try {
      await this.send('Page.navigate', { url: options.url });
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

    // P0-1: Check if we actually broke out or timed out
    const finalReadyState = await this.evaluate<string>('document.readyState').catch(() => '');
    const expectedState = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    if (finalReadyState !== 'complete' && finalReadyState !== expectedState) {
      throw new TimeoutError(`Navigation timeout after ${navTimeout}ms (readyState: ${finalReadyState})`);
    }

    // P0-2: Try to get real HTTP status from Performance API
    const currentUrl = await this.evaluate<string>('document.URL').catch(() => options.url);
    const status = await this.evaluate<number>(
      `(function() { try { var e = performance.getEntriesByType('navigation')[0]; return e ? e.responseStatus || 200 : 200; } catch(ex) { return 200; } })()`
    ).catch(() => 200);

    return {
      url: currentUrl,
      status,
      loadTime: Date.now() - startTime,
    };
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    try {
      // Try WebKit Protocol: Page.snapshotRect
      // Get viewport dimensions first
      const viewport = await this.evaluate<{ w: number; h: number }>(
        '({w: window.innerWidth, h: window.innerHeight})',
      );

      const clip = options?.clip ?? { x: 0, y: 0, width: viewport.w, height: viewport.h };

      const result = await this.send<{ dataURL: string }>('Page.snapshotRect', {
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
    } catch {
      // Fallback: return empty buffer (simctl screenshot handled at higher level)
      throw new Error('Screenshot failed — use SimulatorManager.screenshot() as fallback');
    }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    // Step 1: Evaluate with returnByValue:false to preserve objectId for Promises.
    // WebKit serializes Promises as {} when returnByValue:true, losing the objectId
    // needed for Runtime.awaitPromise.
    const result = await this.send<{
      result: { type: string; subtype?: string; className?: string; value?: unknown; objectId?: string; description?: string };
      wasThrown: boolean;
    }>('Runtime.evaluate', {
      expression,
      returnByValue: false,
      emulateUserGesture: true,
    });

    if (result.wasThrown) {
      throw new EvaluationError(result.result?.description ?? 'Evaluation failed');
    }

    // Step 2: If result is a Promise, use awaitPromise to get the resolved value
    // WebKit Inspector may use subtype:'promise' OR className:'Promise' depending on version
    const isPromise = result.result?.type === 'object' && result.result?.objectId &&
      (result.result?.subtype === 'promise' || result.result?.className === 'Promise');
    if (isPromise) {
      // Note: awaitPromise blocks until the Promise settles. Never-resolving Promises
      // will block for the full send() timeout (DEFAULT_WEBKIT_SEND_TIMEOUT_MS, typically 15s).
      const awaited = await this.send<{
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

    // Step 3: For non-Promise object results, use callFunctionOn to serialize the value
    // without re-executing the expression (avoids double side effects)
    if (result.result?.objectId && result.result?.value === undefined) {
      const valued = await this.send<{
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

  async getCookies(domain?: string): Promise<Cookie[]> {
    // Use document.cookie directly — Page.getCookies crashes the ios-webkit-debug-proxy
    // connection. Note: httpOnly cookies are not visible via document.cookie.
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
    // Use document.cookie directly — Page.setCookie crashes the ios-webkit-debug-proxy
    // connection. httpOnly and sameSite attributes cannot be set via this approach.
    for (const cookie of cookies) {
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

  async clearCookies(): Promise<void> {
    // Use JS directly — Page.deleteAllCookies crashes ios-webkit-debug-proxy.
    // Note: httpOnly cookies cannot be cleared via this approach.
    await this.evaluate(`
      document.cookie.split(';').forEach(function(c) {
        var name = c.trim().split('=')[0];
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      });
    `);
  }

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
    await this.evaluate(`
      (function(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return;
        var touch = document.createTouch(window, el, 1, x, y, x, y);
        var touchList = document.createTouchList(touch);
        var emptyList = document.createTouchList();
        el.dispatchEvent(new TouchEvent('touchstart', { touches: touchList, changedTouches: touchList, bubbles: true }));
        el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: touchList, bubbles: true }));
        el.click();
      })(${x}, ${y})
    `);
  }

  async type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    // Click to focus
    await this.click(selector);

    if (options?.delay) {
      // Character-by-character mode with delay
      for (const char of text) {
        await this.evaluate(`
          (function() {
            var el = document.activeElement;
            if (!el) return;
            var ev = new KeyboardEvent('keydown', { key: ${JSON.stringify(char)}, bubbles: true });
            el.dispatchEvent(ev);
            el.dispatchEvent(new KeyboardEvent('keypress', { key: ${JSON.stringify(char)}, bubbles: true }));
            // Append character
            if (el.value !== undefined) {
              el.value += ${JSON.stringify(char)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(char)}, bubbles: true }));
          })()
        `);
        await new Promise(r => setTimeout(r, options.delay));
      }
    } else {
      // Fast mode: set value directly + dispatch events
      await this.evaluate(`
        (function() {
          var el = document.activeElement;
          if (!el) return;
          // Use native setter for React/Vue compatibility
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          );
          var textareaSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          );
          var setter = (el.tagName === 'TEXTAREA' ? textareaSetter : nativeSetter);
          if (setter && setter.set) {
            setter.set.call(el, ${JSON.stringify(text)});
          } else {
            el.value = ${JSON.stringify(text)};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
    }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const scrollMap: Record<string, string> = {
      up: `window.scrollBy(0, -${amount})`,
      down: `window.scrollBy(0, ${amount})`,
      left: `window.scrollBy(-${amount}, 0)`,
      right: `window.scrollBy(${amount}, 0)`,
    };
    await this.evaluate(scrollMap[direction]);
  }

  async longPress(selector: string, duration?: number): Promise<void> {
    const center = await this.getElementCenter(selector);
    if (!center) throw new Error(`Element not found: ${selector}`);
    const dur = duration ?? 500;

    await this.evaluate(`
      (async function(x, y, duration) {
        var el = document.elementFromPoint(x, y);
        if (!el) return;
        var touch = document.createTouch(window, el, 1, x, y, x, y);
        var touchList = document.createTouchList(touch);
        el.dispatchEvent(new TouchEvent('touchstart', { touches: touchList, changedTouches: touchList, bubbles: true }));
        await new Promise(function(r) { setTimeout(r, duration); });
        var emptyList = document.createTouchList();
        el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: touchList, bubbles: true }));
      })(${center.x}, ${center.y}, ${dur})
    `);
  }

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

    await this.evaluate(`
      (async function(sx, sy, ex, ey, steps) {
        var el = document.elementFromPoint(sx, sy);
        if (!el) return;
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
          await new Promise(function(r) { setTimeout(r, 16); });
        }
        var endTouch = makeTouch(ex, ey);
        var endList = document.createTouchList(endTouch);
        var emptyList = document.createTouchList();
        el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: endList, bubbles: true }));
      })(${sx}, ${sy}, ${ex}, ${ey}, ${steps})
    `);
  }

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

    const mapped = keyMap[key] ?? { key, code: 'Key' + key.toUpperCase(), keyCode: key.charCodeAt(0) };
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

  async dismissKeyboard(): Promise<void> {
    await this.evaluate('document.activeElement && document.activeElement.blur()');
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.evaluate(`
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

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

  // ========== Event Convenience Methods ==========

  onConsole(handler: (msg: { type: string; text: string }) => void): void {
    this.enableDomain('Console').then(() => {
      this.on('Console.messageAdded', (params: any) => {
        handler({
          type: params.message?.level ?? params.message?.type ?? 'log',
          text: params.message?.text ?? '',
        });
      });
    });
  }

  onPageLoad(handler: () => void): void {
    this.enableDomain('Page').then(() => {
      this.on('Page.loadEventFired', handler);
    });
  }

  onRequest(handler: (request: { url: string; method: string }) => void): void {
    this.enableDomain('Network').then(() => {
      this.on('Network.requestWillBeSent', (params: any) => {
        handler({
          url: params.request?.url ?? '',
          method: params.request?.method ?? 'GET',
        });
      });
    });
  }

  onResponse(handler: (response: { url: string; status: number }) => void): void {
    this.enableDomain('Network').then(() => {
      this.on('Network.responseReceived', (params: any) => {
        handler({
          url: params.response?.url ?? '',
          status: params.response?.status ?? 0,
        });
      });
    });
  }

  // ========== Private Helpers ==========

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
    return this.evaluate<{ width: number; height: number }>('({width: window.innerWidth, height: window.innerHeight})');
  }

  private async connectToTarget(wsUrl: string): Promise<void> {
    // Set up target discovery promise before connecting
    this.activeTargetId = null;
    this.targetReady = new Promise<void>((resolve) => {
      this.targetReadyResolve = resolve;
    });

    await new Promise<void>((resolve, reject) => {
      const connectTimeout =
        this.options.connectTimeout ?? DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS;

      const timeout = setTimeout(() => {
        reject(
          new ConnectionError(
            `Connection timeout after ${connectTimeout}ms`,
          ),
        );
      }, connectTimeout);

      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.connected = true;
        this.startHeartbeat();
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        if (this.connected && !this.reconnecting) {
          this.connected = false;
          this.handleDisconnect();
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new ConnectionError(`WebSocket error: ${err.message}`));
        }
      });
    });

    // Wait for first page target to be discovered
    const connectTimeout =
      this.options.connectTimeout ?? DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS;
    let targetTimer: ReturnType<typeof setTimeout>;
    const targetTimeout = new Promise<never>((_, reject) => {
      targetTimer = setTimeout(
        () => reject(new ConnectionError('No page target discovered — is Safari open in the simulator?')),
        connectTimeout,
      );
    });
    try {
      await Promise.race([this.targetReady, targetTimeout]);
    } finally {
      clearTimeout(targetTimer!);
    }
  }

  private clearPendingRequests(): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Connection closed'));
    }
    this.pendingRequests.clear();

    for (const [, req] of this.innerPendingRequests) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Connection closed'));
    }
    this.innerPendingRequests.clear();
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  }
}

// ========== Error Classes ==========

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}
