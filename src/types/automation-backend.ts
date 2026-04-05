/**
 * AutomationBackend — Umbrella type for all automation backends.
 *
 * Safari uses BrowserBackend (WebKit Remote Debugging Protocol).
 * Native app automation will use NativeAppBackend (simctl + accessibility).
 * Both share simulator lifecycle via SessionManager.
 */

export type BackendType = 'safari' | 'native-app';

/**
 * Common capabilities shared by all automation backends.
 * Both BrowserBackend (Safari) and NativeAppBackend implement these.
 */
export interface AutomationBackendBase {
  readonly backendType: BackendType;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Common capabilities
  screenshot(options?: { clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
}

/** Union type for routing — SessionManager stores this */
export type AutomationBackend = import('./browser-backend').BrowserBackend | import('./native-app-backend').NativeAppBackend;
