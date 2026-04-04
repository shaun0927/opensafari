/**
 * BrowserBackend — Abstract interface for Safari browser control.
 *
 * This is the Safari equivalent of OpenChrome's CDPClient.
 * SafariClient (WebKitClient) implements this interface to provide
 * browser automation via WebKit Remote Debugging Protocol.
 */

import { BackendType } from './automation-backend';

// Navigation
export interface NavigateOptions {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface NavigateResult {
  url: string;
  status: number;
  loadTime: number;
}

// Screenshot
export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: 'png';  // WebKit's Page.snapshotRect returns PNG only
  clip?: { x: number; y: number; width: number; height: number };
}

// DOM
export interface ElementInfo {
  selector: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  computedStyles?: Record<string, string>;
  isVisible: boolean;
}

// Cookies
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// Main interface
export interface BrowserBackend {
  /** Backend type identifier. Defaults to 'safari' if not set. */
  readonly backendType?: BackendType;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Core
  navigate(options: NavigateOptions): Promise<NavigateResult>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  readPage(): Promise<string>;

  // Cookies (WebKit Page domain: Page.getCookies, Page.setCookie, Page.deleteCookie)
  getCookies(domain?: string): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  clearCookies(): Promise<void>;

  // Interaction
  click(target: string | { x: number; y: number }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;
  longPress(selector: string, duration?: number): Promise<void>;
  swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void>;
  press(key: string): Promise<void>;
  dismissKeyboard(): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;

  // DOM
  querySelector(selector: string): Promise<ElementInfo | null>;
  querySelectorAll(selector: string): Promise<ElementInfo[]>;
  inspect(selector: string): Promise<Record<string, unknown>>;
  waitFor(selector: string, options?: { visible?: boolean; timeout?: number }): Promise<void>;

  // Event convenience methods
  onConsole(handler: (msg: { type: string; text: string }) => void): void;
  onRequest(handler: (request: { url: string; method: string }) => void): void;
  onResponse(handler: (response: { url: string; status: number }) => void): void;
  onError?(handler: (error: { message: string; stack?: string; source?: string; line?: number; column?: number }) => void): void;

  // Events — provided by EventEmitter (Node.js).
  // Implementations should extend EventEmitter rather than manually
  // implementing on/off/removeAllListeners.  Known event names:
  //   'console'    — (msg: { type: string; text: string }) => void
  //   'pageerror'  — (error: Error) => void
  //   'load'       — () => void
  //   'disconnect' — () => void
  //   'reconnected' — () => void
}
