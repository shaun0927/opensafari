import { EventEmitter } from 'events';
import { BrowserBackend, NavigateOptions, NavigateResult, ScreenshotOptions, ElementInfo, Cookie } from '../types/browser-backend';
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
export declare class WebKitClient extends EventEmitter implements BrowserBackend {
    private options;
    private ws;
    private messageId;
    private pendingRequests;
    private enabledDomains;
    private connected;
    private heartbeatTimer;
    private lastUrl;
    private reconnecting;
    constructor(options: WebKitClientOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    listTargets(): Promise<WebKitTarget[]>;
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    private handleMessage;
    enableDomain(domain: string): Promise<void>;
    private startHeartbeat;
    private stopHeartbeat;
    private handleDisconnect;
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
    onConsole(handler: (msg: {
        type: string;
        text: string;
    }) => void): void;
    onPageLoad(handler: () => void): void;
    onRequest(handler: (request: {
        url: string;
        method: string;
    }) => void): void;
    onResponse(handler: (response: {
        url: string;
        status: number;
    }) => void): void;
    private getElementCenter;
    private getViewportSize;
    private connectToTarget;
    private clearPendingRequests;
    private httpGet;
}
export declare class ConnectionError extends Error {
    constructor(message: string);
}
export declare class TimeoutError extends Error {
    constructor(message: string);
}
export declare class ProtocolError extends Error {
    readonly code?: number | undefined;
    constructor(message: string, code?: number | undefined);
}
export declare class EvaluationError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=client.d.ts.map