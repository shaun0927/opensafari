/**
 * NativeAppBackend — Interface for native iOS app automation.
 *
 * Implements automation via simctl + accessibility snapshots.
 * This is a stub interface for the upcoming native-app backend.
 */

import { AutomationBackendBase } from './automation-backend';

export interface AccessibilityElement {
  type: string;           // e.g., 'Button', 'TextField', 'StaticText', 'Image'
  label: string | null;
  value: string | null;
  identifier: string | null;
  frame: { x: number; y: number; width: number; height: number };
  traits: string[];
  children: AccessibilityElement[];
  isEnabled: boolean;
  isSelected: boolean;
}

export interface AppInfo {
  bundleId: string;
  name: string;
  state: 'running' | 'suspended' | 'not-running';
  pid?: number;
}

export interface NativeAppBackend extends AutomationBackendBase {
  readonly backendType: 'native-app';

  // App lifecycle
  launchApp(bundleId: string, args?: string[]): Promise<AppInfo>;
  terminateApp(bundleId: string): Promise<void>;
  getAppState(bundleId: string): Promise<AppInfo>;
  listApps(): Promise<AppInfo[]>;

  // Accessibility tree
  getAccessibilityTree(): Promise<AccessibilityElement>;
  findElements(query: { type?: string; label?: string; identifier?: string }): Promise<AccessibilityElement[]>;
  getElementInfo(identifier: string): Promise<AccessibilityElement | null>;

  // Interactions (coordinate-based)
  tap(target: { x: number; y: number } | { identifier: string }): Promise<void>;
  typeText(text: string): Promise<void>;
  swipe(direction: 'up' | 'down' | 'left' | 'right', speed?: number): Promise<void>;
  longPress(target: { x: number; y: number } | { identifier: string }, duration?: number): Promise<void>;

  // System surfaces
  handleAlert(action: 'accept' | 'dismiss'): Promise<void>;
  setPermission(bundleId: string, permission: string, value: 'yes' | 'no' | 'unset'): Promise<void>;
  openDeepLink(url: string): Promise<void>;

  // Screenshot (inherited from AutomationBackendBase, fully implemented)
  screenshot(options?: { clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
}
