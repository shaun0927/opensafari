import http from 'http';
import { EventEmitter } from 'events';
import { ConnectionError } from './errors';
export { ConnectionError, TimeoutError, ProtocolError, EvaluationError } from './errors';
import { ProtocolTransport, WebSocketProtocolTransport } from './protocol-transport';
export type { ProtocolTransport, ProtocolEventHandler } from './protocol-transport';
import { TargetSessionManager } from './target-session';
export type { TargetCommandSender } from './target-session';
import { BrowserCommands } from './browser-commands';
import {
  EventBridge,
  ConsoleMessage,
  RequestInfo,
  ResponseInfo,
  ErrorInfo,
} from './events';
export type {
  TargetCreatedPayload,
  TargetDestroyedPayload,
  ConsoleMessage,
  RequestInfo,
  ResponseInfo,
  ErrorInfo,
} from './events';
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
  private transport: ProtocolTransport;
  private messageId = 0;
  private innerMessageId = 0;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastUrl: string = '';
  private reconnecting = false;
  readonly backendType = 'safari' as const;

  private targetSession: TargetSessionManager;
  private browserCommands: BrowserCommands;
  private eventBridge: EventBridge;

  constructor(private options: WebKitClientOptions) {
    super();
    this.transport = new WebSocketProtocolTransport({
      connectTimeout: options.connectTimeout,
      sendTimeout: options.sendTimeout,
    });
    this.targetSession = new TargetSessionManager(this.transport, this);
    this.browserCommands = new BrowserCommands(this);
    this.eventBridge = new EventBridge(this.transport, this.targetSession, this);
    this.eventBridge.attach();
    // transport:close / transport:error are handled here, not in EventBridge
    this.transport.on('transport:close', () => {
      if (this.connected && !this.reconnecting) {
        this.connected = false;
        this.handleDisconnect();
      }
    });
    this.transport.on('transport:error', (_err: Error) => {
      // Error already handled — connection state tracked via transport:close
    });
  }

  getHost(): string { return this.options.host; }
  getPort(): number { return this.options.port; }

  /**
   * Connect directly to a specific WebSocket URL (e.g., per-tab endpoint).
   */
  async connectToUrl(wsUrl: string, options?: { retries?: number; retryDelay?: number }): Promise<void> {
    const maxRetries = options?.retries ?? 0;
    const delay = options?.retryDelay ?? 2000;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.connectToTarget(wsUrl);
        return;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error('WebKit connection failed');
  }

  // ========== Lifecycle ==========

  async connect(options?: { retries?: number; retryDelay?: number }): Promise<void> {
    const maxRetries = options?.retries ?? 0;
    const delay = options?.retryDelay ?? 2000;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const targets = await this.listTargets();
        const targetIndex = this.options.targetIndex ?? 0;

        if (targets.length === 0) {
          throw new ConnectionError(
            'No Safari targets found. Is Safari open in the simulator?',
          );
        }

        const target = targets[Math.min(targetIndex, targets.length - 1)];
        await this.connectToTarget(target.webSocketDebuggerUrl);
        return;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          console.error(`[WebKitClient] Connect attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error('WebKit connection failed');
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    await this.transport.disconnect();
    this.connected = false;
    this.targetSession.reset();
    this.targetSession.resetGlobalDomains();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  // ========== Target Discovery ==========

  async listTargets(): Promise<WebKitTarget[]> {
    const url = `http://${this.options.host}:${this.options.port}/json`;
    const json = await this.httpGet(url);
    const parsed = JSON.parse(json) as WebKitTarget[];

    // ios-webkit-debug-proxy device-list mode: the top-level /json returns
    // redirect entries of the form { url: "host:PORT" } with no
    // webSocketDebuggerUrl. Follow each redirect to get real page targets.
    // A single /json response may mix redirect stubs with inline page targets,
    // so resolve per-entry rather than all-or-nothing.
    const isDeviceRedirect = (t: WebKitTarget) =>
      !t.webSocketDebuggerUrl && typeof t.url === 'string' && /^\S+:\d+$/.test(t.url);

    const expanded = await Promise.all(
      parsed.map(async (t) => {
        if (!isDeviceRedirect(t)) return [t];
        try {
          const redirectJson = await this.httpGet(`http://${t.url}/json`);
          return JSON.parse(redirectJson) as WebKitTarget[];
        } catch {
          return [] as WebKitTarget[];
        }
      }),
    );
    const targets = expanded.flat();

    // ios-webkit-debug-proxy doesn't include an `id` field — derive from webSocketDebuggerUrl
    for (const t of targets) {
      if (!t.id && t.webSocketDebuggerUrl) {
        const match = t.webSocketDebuggerUrl.match(/\/devtools\/page\/(\S+)/);
        if (match) t.id = match[1];
      }
    }

    return targets;
  }

  // ========== Protocol Message Layer ==========

  /**
   * Send a protocol command to the active target.
   * For multi-tab, use sendToTarget() with an explicit targetId.
   */
  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return this.sendToTarget<T>(method, params, this.targetSession.getActiveTargetId());
  }

  /**
   * Send a protocol command to a specific target (tab).
   * @param targetId - Target to send to. Falls back to activeTargetId if null.
   */
  async sendToTarget<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    targetId?: string | null,
  ): Promise<T> {
    const resolvedTargetId = targetId ?? this.targetSession.getActiveTargetId();
    if (!resolvedTargetId) {
      throw new ConnectionError(
        'No active target. Is Safari open in the simulator?',
      );
    }

    const innerId = ++this.innerMessageId;
    const outerId = ++this.messageId;
    const timeout = this.options.sendTimeout ?? DEFAULT_WEBKIT_SEND_TIMEOUT_MS;

    return this.transport.sendToTarget<T>(method, params, resolvedTargetId, innerId, outerId, timeout);
  }

  // ========== Domain Management ==========

  async enableDomain(domain: string): Promise<void> {
    if (!this.targetSession.hasGlobalEnabledDomain(domain)) {
      await this.send(`${domain}.enable`);
      this.targetSession.addGlobalEnabledDomain(domain);
    }
  }

  /**
   * Enable a domain on a specific target (tab).
   * Tracks the domain per-target so it can be re-enabled after target recreation.
   */
  async enableDomainForTarget(domain: string, targetId: string): Promise<void> {
    await this.sendToTarget(`${domain}.enable`, undefined, targetId);
    this.targetSession.addEnabledDomainForTarget(domain, targetId);
  }

  // ========== Multi-Tab Target Management ==========

  getActiveTargetId(): string | null {
    return this.targetSession.getActiveTargetId();
  }

  setActiveTargetId(targetId: string): void {
    this.targetSession.setActiveTargetId(targetId);
  }

  getKnownTargets(): Set<string> {
    return this.targetSession.getKnownTargets();
  }

  getEnabledDomainsForTarget(targetId: string): Set<string> {
    return this.targetSession.getEnabledDomainsForTarget(targetId);
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

    // Tear down the transport so any stale pending requests are rejected
    // before reconnecting, then reset target-session state owned by the
    // extracted TargetSessionManager.
    await this.transport.disconnect();
    this.targetSession.resetTargets();

    this.stopHeartbeat();

    let attempt = 0;
    const maxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS;

    while (attempt < maxAttempts) {
      attempt++;
      const baseDelay = Math.min(
        DEFAULT_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        DEFAULT_RECONNECT_MAX_DELAY_MS,
      );
      const jitter = baseDelay * 0.2 * (2 * Math.random() - 1);
      const delay = Math.max(0, Math.round(baseDelay + jitter));

      console.error(
        `[WebKitClient] Reconnection attempt ${attempt}/${maxAttempts} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));

      try {
        await this.connect();
        console.error(`[WebKitClient] Reconnected successfully`);

        // Re-enable domains (global + per-target state is rebuilt via enableDomain/enableDomainForTarget)
        const domains = this.targetSession.snapshotGlobalDomains();
        this.targetSession.resetGlobalDomains();
        this.targetSession.resetPerTargetDomains();
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

  // ========== BrowserBackend — thin facade delegating to BrowserCommands ==========

  async navigate(options: NavigateOptions): Promise<NavigateResult> {
    return this.browserCommands.navigate(options, (url) => { this.lastUrl = url; });
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return this.browserCommands.screenshot(options);
  }

  async evaluate<T = unknown>(expression: string, options?: { emulateUserGesture?: boolean }): Promise<T> {
    return this.browserCommands.evaluate<T>(expression, options);
  }

  async readPage(): Promise<string> {
    return this.browserCommands.readPage();
  }

  async getCookies(domain?: string): Promise<Cookie[]> {
    return this.browserCommands.getCookies(domain);
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    return this.browserCommands.setCookies(cookies);
  }

  async clearCookies(): Promise<void> {
    return this.browserCommands.clearCookies();
  }

  async click(target: string | { x: number; y: number }): Promise<void> {
    return this.browserCommands.click(target);
  }

  async type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    return this.browserCommands.type(selector, text, options);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    return this.browserCommands.scroll(direction, amount);
  }

  async longPress(selector: string, duration?: number): Promise<void> {
    return this.browserCommands.longPress(selector, duration);
  }

  async swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void> {
    return this.browserCommands.swipe(direction, speed);
  }

  async press(key: string): Promise<void> {
    return this.browserCommands.press(key);
  }

  async dismissKeyboard(): Promise<void> {
    return this.browserCommands.dismissKeyboard();
  }

  async selectOption(selector: string, value: string): Promise<void> {
    return this.browserCommands.selectOption(selector, value);
  }

  async querySelector(selector: string): Promise<ElementInfo | null> {
    return this.browserCommands.querySelector(selector);
  }

  async querySelectorAll(selector: string): Promise<ElementInfo[]> {
    return this.browserCommands.querySelectorAll(selector);
  }

  async inspect(selector: string): Promise<Record<string, unknown>> {
    return this.browserCommands.inspect(selector);
  }

  async waitFor(selector: string, options?: { visible?: boolean; timeout?: number }): Promise<void> {
    return this.browserCommands.waitFor(selector, options);
  }

  // ========== Event Convenience Methods (delegated to EventBridge) ==========

  onConsole(handler: (msg: ConsoleMessage) => void): void {
    this.eventBridge.onConsole(handler);
  }

  onPageLoad(handler: () => void): void {
    this.eventBridge.onPageLoad(handler);
  }

  onRequest(handler: (request: RequestInfo) => void): void {
    this.eventBridge.onRequest(handler);
  }

  onResponse(handler: (response: ResponseInfo) => void): void {
    this.eventBridge.onResponse(handler);
  }

  onError(handler: (error: ErrorInfo) => void): void {
    this.eventBridge.onError(handler);
  }

  // ========== Private Helpers ==========

  private async connectToTarget(wsUrl: string): Promise<void> {
    // Set up target discovery promise before connecting
    const targetReady = this.targetSession.prepareForConnect();

    await this.transport.connect(wsUrl);
    this.connected = true;
    this.startHeartbeat();

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
      await Promise.race([targetReady, targetTimeout]);
    } finally {
      clearTimeout(targetTimer!);
    }
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      http
        .get(url, { agent: false }, (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  }
}
