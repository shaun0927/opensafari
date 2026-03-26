import {
  BrowserBackend,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ElementInfo,
  Cookie,
} from '../types/browser-backend';

/**
 * WebKitClient — Safari browser automation via WebKit Remote Debugging Protocol.
 *
 * This is the canonical name for the Safari client (Epic 1B refers to it as "SafariClient"
 * in high-level descriptions, but the actual class name is WebKitClient).
 *
 * Equivalent to OpenChrome's CDPClient — connects directly to real Safari
 * in Xcode Simulator via the WebKit Inspector Protocol.
 *
 * Stub implementation — actual protocol implementation in Epic 1B.
 */

export interface WebKitClientOptions {
  host: string;
  port: number;
  targetIndex?: number;
  connectTimeout?: number;
  heartbeatInterval?: number;
}

export class WebKitClient implements BrowserBackend {
  private connected = false;

  constructor(private options: WebKitClientOptions) {}

  // Lifecycle
  async connect(): Promise<void> {
    // TODO(Epic 1B): Implement WebKit Remote Debugging Protocol connection
    throw new Error('Not implemented — see Epic 1B, Story #33');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Core
  async navigate(_options: NavigateOptions): Promise<NavigateResult> {
    throw new Error('Not implemented — see Epic 1B, Story #34');
  }

  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    throw new Error('Not implemented — see Epic 1B, Story #34');
  }

  async evaluate<T = unknown>(_expression: string): Promise<T> {
    throw new Error('Not implemented — see Epic 1B, Story #34');
  }

  async readPage(): Promise<string> {
    throw new Error('Not implemented — see Epic 1B, Story #34');
  }

  // Cookies (WebKit Page domain: Page.getCookies, Page.setCookie, Page.deleteCookie)
  async getCookies(_domain?: string): Promise<Cookie[]> {
    throw new Error('Not implemented — see Epic 1B, Story #35');
  }

  async setCookies(_cookies: Cookie[]): Promise<void> {
    throw new Error('Not implemented — see Epic 1B, Story #35');
  }

  async clearCookies(): Promise<void> {
    throw new Error('Not implemented — see Epic 1B, Story #35');
  }

  // Interaction
  async click(_target: string | { x: number; y: number }): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #38');
  }

  async type(_selector: string, _text: string, _options?: { delay?: number }): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #39');
  }

  async scroll(_direction: 'up' | 'down' | 'left' | 'right', _amount: number): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #40');
  }

  async longPress(_selector: string, _duration?: number): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #38');
  }

  async swipe(_direction: 'up' | 'down' | 'left' | 'right', _speed?: number): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #38');
  }

  async press(_key: string): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #39');
  }

  async dismissKeyboard(): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #39');
  }

  async selectOption(_selector: string, _value: string): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #39');
  }

  // DOM
  async querySelector(_selector: string): Promise<ElementInfo | null> {
    throw new Error('Not implemented — see Epic 1C, Story #40');
  }

  async querySelectorAll(_selector: string): Promise<ElementInfo[]> {
    throw new Error('Not implemented — see Epic 1C, Story #40');
  }

  async inspect(_selector: string): Promise<Record<string, unknown>> {
    throw new Error('Not implemented — see Epic 1C, Story #40');
  }

  async waitFor(_selector: string, _options?: { visible?: boolean; timeout?: number }): Promise<void> {
    throw new Error('Not implemented — see Epic 1C, Story #40');
  }

  // Events
  on(event: 'console', handler: (msg: { type: string; text: string }) => void): void;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  on(event: 'load', handler: () => void): void;
  on(event: 'disconnect', handler: () => void): void;
  on(
    _event: string,
    _handler:
      | ((msg: { type: string; text: string }) => void)
      | ((error: Error) => void)
      | (() => void),
  ): void {
    // TODO(Epic 1B): Implement event subscriptions
  }

  off(_event: string, _handler: Function): void {
    // TODO(Epic 1B)
  }

  removeAllListeners(_event?: string): void {
    // TODO(Epic 1B)
  }
}
