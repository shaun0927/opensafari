/**
 * Types for native iOS app automation via NativeAppBackend.
 *
 * These types define the contract for all native app operations —
 * lifecycle, inspection, interaction, system, and observability.
 */

// ── Lifecycle ──────────────────────────────────────────────────────

export interface AppLaunchOptions {
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Extra CLI arguments passed to the app on launch. */
  arguments?: string[];
  /** Environment variables injected into the app process. */
  environment?: Record<string, string>;
  /** Wait for the app to reach foreground before resolving. */
  waitForDebugger?: boolean;
}

export interface AppProcessInfo {
  /** Bundle identifier of the launched app. */
  bundleId: string;
  /** OS-level process ID, if available. */
  pid?: number;
  /** Device UDID the app is running on. */
  deviceId: string;
}

export interface AppInfo {
  /** Bundle identifier (e.g. "com.apple.mobilesafari"). */
  bundleId: string;
  /** Human-readable display name. */
  displayName: string;
  /** Semantic version string, if available. */
  version?: string;
  /** Path to the app bundle on the simulator filesystem. */
  bundlePath?: string;
}

// ── Accessibility / Inspection ─────────────────────────────────────

export interface AccessibilityNode {
  /** Accessibility identifier set by the developer. */
  identifier?: string;
  /** Accessibility label (user-visible text). */
  label?: string;
  /** Current value of the element (e.g. text field contents). */
  value?: string;
  /** Accessibility role (e.g. "button", "staticText", "cell"). */
  role?: string;
  /** Accessibility traits (e.g. ["button", "selected"]). */
  traits?: string[];
  /** Screen-space frame: { x, y, width, height }. */
  frame?: { x: number; y: number; width: number; height: number };
  /** Ordered child nodes forming the subtree. */
  children?: AccessibilityNode[];
  /** Whether the element is currently visible on screen. */
  isVisible?: boolean;
  /** Whether the element is enabled for interaction. */
  isEnabled?: boolean;
}

export interface TreeOptions {
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Bundle ID to scope the tree to a specific app. */
  bundleId?: string;
  /** Maximum depth of the tree to return. */
  maxDepth?: number;
}

/** Strategy used to locate elements in the accessibility tree. */
export type QueryStrategy =
  | 'accessibilityId'
  | 'label'
  | 'text'
  | 'role'
  | 'predicate';

// ── Interaction ────────────────────────────────────────────────────

/**
 * Target for interaction commands.
 * Either a string selector (interpreted via QueryStrategy)
 * or raw screen coordinates.
 */
export type ElementTarget = string | { x: number; y: number };

export interface TapOptions {
  /** How long to hold before releasing, in milliseconds. */
  duration?: number;
  /** Number of taps (default 1, use 2 for double-tap). */
  tapCount?: number;
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Strategy for resolving a string target. */
  strategy?: QueryStrategy;
}

export interface TypeOptions {
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Strategy for resolving a string target. */
  strategy?: QueryStrategy;
  /** Delay between keystrokes in milliseconds. */
  keyDelay?: number;
}

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface SwipeOptions {
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Speed of the swipe in points per second. */
  speed?: number;
  /** Distance to swipe in points. */
  distance?: number;
  /** Starting point override. */
  startPoint?: { x: number; y: number };
}

// ── System ─────────────────────────────────────────────────────────

export type AlertAction = 'accept' | 'dismiss';

export interface AlertResult {
  /** Whether the alert was handled. */
  handled: boolean;
  /** Text of the button that was tapped. */
  buttonText?: string;
  /** Alert title, if readable. */
  alertTitle?: string;
}

/** Permission value for simctl privacy commands. */
export type PermissionValue = 'grant' | 'revoke' | 'reset';

// ── Observability ──────────────────────────────────────────────────

export interface LogOptions {
  /** Device UDID. Defaults to "booted". */
  deviceId?: string;
  /** Bundle ID to filter logs by process name. */
  bundleId?: string;
  /** Maximum number of log lines to return. */
  lines?: number;
  /** Only return logs after this ISO 8601 timestamp. */
  since?: string;
  /** Log level filter. */
  level?: 'debug' | 'info' | 'error' | 'fault';
}

export interface LogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Log level. */
  level: string;
  /** Process that emitted the log. */
  process: string;
  /** Log message body. */
  message: string;
}
