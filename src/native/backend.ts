/**
 * NativeAppBackend — Abstract interface for native iOS app automation.
 *
 * This is the native-app counterpart of the WebKit client for Safari.
 * Implementations wrap a concrete automation mechanism (simctl, XCTest, etc.)
 * behind a stable contract so MCP tools can remain backend-agnostic.
 */

import type {
  AppLaunchOptions,
  AppProcessInfo,
  AppInfo,
  TreeOptions,
  AccessibilityNode,
  QueryStrategy,
  ElementTarget,
  TapOptions,
  TypeOptions,
  SwipeDirection,
  SwipeOptions,
  AlertAction,
  AlertResult,
  PermissionValue,
  LogOptions,
  LogEntry,
} from './types';

export interface NativeAppBackend {
  // ── Lifecycle ──────────────────────────────────────────────────

  /** Launch an app by bundle identifier. */
  launch(bundleId: string, options?: AppLaunchOptions): Promise<AppProcessInfo>;

  /** Terminate a running app. */
  terminate(bundleId: string, deviceId?: string): Promise<void>;

  /** List apps installed on the device. */
  listApps(deviceId?: string): Promise<AppInfo[]>;

  // ── Inspection ─────────────────────────────────────────────────

  /** Retrieve the full accessibility tree (v1.5+). */
  getAccessibilityTree(options?: TreeOptions): Promise<AccessibilityNode>;

  /** Query elements matching a selector string (v1.5+). */
  queryElements(selector: string, strategy?: QueryStrategy): Promise<AccessibilityNode[]>;

  // ── Interaction ────────────────────────────────────────────────

  /** Tap an element or coordinate (v2+). */
  tap(target: ElementTarget, options?: TapOptions): Promise<void>;

  /** Type text into the focused element or a targeted element (v2+). */
  typeText(target: ElementTarget, text: string, options?: TypeOptions): Promise<void>;

  /** Perform a directional swipe gesture (v2+). */
  swipe(direction: SwipeDirection, options?: SwipeOptions): Promise<void>;

  // ── System ─────────────────────────────────────────────────────

  /** Handle a system alert (v1.5+). */
  handleAlert(action: AlertAction, buttonText?: string): Promise<AlertResult>;

  /** Grant, revoke, or reset a permission for a bundle. */
  setPermission(permission: string, value: PermissionValue, bundleId: string, deviceId?: string): Promise<void>;

  /** Open a URL (deep link or universal link) on the device. */
  openUrl(url: string, deviceId?: string): Promise<void>;

  /** Deliver a simulated push notification. */
  sendPushNotification(bundleId: string, payload: Record<string, unknown>, deviceId?: string): Promise<void>;

  // ── Observability ──────────────────────────────────────────────

  /** Capture a full-device screenshot and return the PNG buffer. */
  captureScreenshot(deviceId?: string): Promise<Buffer>;

  /** Retrieve recent log entries, optionally filtered. */
  getLogs(options?: LogOptions): Promise<LogEntry[]>;
}

/**
 * Error thrown when a backend method is not yet implemented in the
 * current version (e.g. interaction primitives in the simctl backend).
 */
export class NotImplementedError extends Error {
  constructor(method: string, reason: string) {
    super(`${method} is not implemented: ${reason}`);
    this.name = 'NotImplementedError';
  }
}
