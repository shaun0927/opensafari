/**
 * BrowserBackend — Abstract interface for Safari browser control.
 *
 * This is the Safari equivalent of OpenChrome's CDPClient.
 * SafariClient (WebKitClient) implements this interface to provide
 * browser automation via WebKit Remote Debugging Protocol.
 */
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
export interface ScreenshotOptions {
    fullPage?: boolean;
    format?: 'png';
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export interface ElementInfo {
    selector: string;
    tag: string;
    text: string;
    attributes: Record<string, string>;
    boundingBox: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    computedStyles?: Record<string, string>;
    isVisible: boolean;
}
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
export interface BrowserBackend {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    navigate(options: NavigateOptions): Promise<NavigateResult>;
    screenshot(options?: ScreenshotOptions): Promise<Buffer>;
    evaluate<T = unknown>(expression: string): Promise<T>;
    readPage(): Promise<string>;
    getCookies(domain?: string): Promise<Cookie[]>;
    setCookies(cookies: Cookie[]): Promise<void>;
    clearCookies(): Promise<void>;
    click(target: string | {
        x: number;
        y: number;
    }): Promise<void>;
    type(selector: string, text: string, options?: {
        delay?: number;
    }): Promise<void>;
    scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;
    longPress(selector: string, duration?: number): Promise<void>;
    swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void>;
    press(key: string): Promise<void>;
    dismissKeyboard(): Promise<void>;
    selectOption(selector: string, value: string): Promise<void>;
    querySelector(selector: string): Promise<ElementInfo | null>;
    querySelectorAll(selector: string): Promise<ElementInfo[]>;
    inspect(selector: string): Promise<Record<string, unknown>>;
    waitFor(selector: string, options?: {
        visible?: boolean;
        timeout?: number;
    }): Promise<void>;
}
//# sourceMappingURL=browser-backend.d.ts.map