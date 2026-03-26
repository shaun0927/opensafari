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

    const id = ++this.messageId;
    const timeout =
      this.options.sendTimeout ?? DEFAULT_WEBKIT_SEND_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new TimeoutError(`${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      // Response to a request
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(
            new ProtocolError(
              msg.error.message ?? JSON.stringify(msg.error),
              msg.error.code,
            ),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      // Event notification
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

    // Set up load event promise
    const waitEvent = options.waitUntil === 'domcontentloaded'
      ? 'Page.domContentEventFired'
      : 'Page.loadEventFired';

    const loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new TimeoutError(`Navigation timeout after ${options.timeout ?? 30000}ms`)),
        options.timeout ?? 30000,
      );
      const handler = () => {
        clearTimeout(timeout);
        this.removeListener(waitEvent, handler);
        resolve();
      };
      this.on(waitEvent, handler);
    });

    // Navigate
    await this.send('Page.navigate', { url: options.url });

    // Wait for load
    await loadPromise;

    return {
      url: options.url,
      status: 200,
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
    const result = await this.send<{
      result: { type: string; subtype?: string; value?: unknown; objectId?: string; description?: string };
      wasThrown: boolean;
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      emulateUserGesture: true,
    });

    if (result.wasThrown) {
      throw new EvaluationError(result.result?.description ?? 'Evaluation failed');
    }

    // Handle Promise results — WebKit requires separate awaitPromise command
    if (result.result?.type === 'object' && result.result?.subtype === 'promise' && result.result?.objectId) {
      const awaited = await this.send<{
        result: { type: string; value?: unknown; description?: string };
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
    await this.enableDomain('Page');
    const result = await this.send<{ cookies: Array<{
      name: string; value: string; domain: string; path: string;
      expires: number; httpOnly: boolean; secure: boolean; sameSite?: string;
    }> }>('Page.getCookies');

    let cookies = result.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as Cookie['sameSite'],
    }));

    if (domain) {
      cookies = cookies.filter(c =>
        c.domain === domain || c.domain === '.' + domain
      );
    }

    return cookies;
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    await this.enableDomain('Page');
    for (const cookie of cookies) {
      await this.send('Page.setCookie', {
        cookie: {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        },
      });
    }
  }

  async clearCookies(): Promise<void> {
    const cookies = await this.getCookies();
    for (const cookie of cookies) {
      await this.send('Page.deleteCookie', {
        cookieName: cookie.name,
        url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`,
      });
    }
  }

  async click(
    _target: string | { x: number; y: number },
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async type(
    _selector: string,
    _text: string,
    _options?: { delay?: number },
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async scroll(
    _direction: 'up' | 'down' | 'left' | 'right',
    _amount: number,
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async longPress(
    _selector: string,
    _duration?: number,
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async swipe(
    _direction: 'up' | 'down' | 'left' | 'right',
    _speed?: number,
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async press(_key: string): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async dismissKeyboard(): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async selectOption(
    _selector: string,
    _value: string,
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async querySelector(
    _selector: string,
  ): Promise<ElementInfo | null> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async querySelectorAll(
    _selector: string,
  ): Promise<ElementInfo[]> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async inspect(
    _selector: string,
  ): Promise<Record<string, unknown>> {
    throw new Error('Not implemented — see Epic 1C');
  }

  async waitFor(
    _selector: string,
    _options?: { visible?: boolean; timeout?: number },
  ): Promise<void> {
    throw new Error('Not implemented — see Epic 1C');
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

  private async connectToTarget(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
  }

  private clearPendingRequests(): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Connection closed'));
    }
    this.pendingRequests.clear();
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
