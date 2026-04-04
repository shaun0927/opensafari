/**
 * NativeAppClient — Stub implementation of NativeAppBackend.
 *
 * This is a placeholder for the upcoming native-app automation backend.
 * All methods throw a "not implemented" error until the backend is built.
 *
 * Future implementation will use:
 * - xcrun simctl for app lifecycle (launch, terminate, list)
 * - Accessibility snapshots for UI tree queries
 * - Coordinate-based touch injection for interactions
 */

import { EventEmitter } from 'events';
import { NativeAppBackend, AccessibilityElement, AppInfo } from '../types/native-app-backend';

export class NativeAppClient extends EventEmitter implements NativeAppBackend {
  readonly backendType = 'native-app' as const;
  private _connected = false;
  private deviceId: string;

  constructor(deviceId: string) {
    super();
    this.deviceId = deviceId;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  // Lifecycle
  async connect(): Promise<void> {
    // Future: verify device is booted, accessibility is available
    this._connected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this._connected;
  }

  // App lifecycle
  async launchApp(_bundleId: string, _args?: string[]): Promise<AppInfo> {
    throw new Error('NativeAppClient.launchApp is not yet implemented');
  }

  async terminateApp(_bundleId: string): Promise<void> {
    throw new Error('NativeAppClient.terminateApp is not yet implemented');
  }

  async getAppState(_bundleId: string): Promise<AppInfo> {
    throw new Error('NativeAppClient.getAppState is not yet implemented');
  }

  async listApps(): Promise<AppInfo[]> {
    throw new Error('NativeAppClient.listApps is not yet implemented');
  }

  // Accessibility
  async getAccessibilityTree(): Promise<AccessibilityElement> {
    throw new Error('NativeAppClient.getAccessibilityTree is not yet implemented');
  }

  async findElements(_query: { type?: string; label?: string; identifier?: string }): Promise<AccessibilityElement[]> {
    throw new Error('NativeAppClient.findElements is not yet implemented');
  }

  async getElementInfo(_identifier: string): Promise<AccessibilityElement | null> {
    throw new Error('NativeAppClient.getElementInfo is not yet implemented');
  }

  // Interactions
  async tap(_target: { x: number; y: number } | { identifier: string }): Promise<void> {
    throw new Error('NativeAppClient.tap is not yet implemented');
  }

  async typeText(_text: string): Promise<void> {
    throw new Error('NativeAppClient.typeText is not yet implemented');
  }

  async swipe(_direction: 'up' | 'down' | 'left' | 'right', _speed?: number): Promise<void> {
    throw new Error('NativeAppClient.swipe is not yet implemented');
  }

  async longPress(_target: { x: number; y: number } | { identifier: string }, _duration?: number): Promise<void> {
    throw new Error('NativeAppClient.longPress is not yet implemented');
  }

  // System surfaces
  async handleAlert(_action: 'accept' | 'dismiss'): Promise<void> {
    throw new Error('NativeAppClient.handleAlert is not yet implemented');
  }

  async setPermission(_bundleId: string, _permission: string, _value: 'yes' | 'no' | 'unset'): Promise<void> {
    throw new Error('NativeAppClient.setPermission is not yet implemented');
  }

  async openDeepLink(_url: string): Promise<void> {
    throw new Error('NativeAppClient.openDeepLink is not yet implemented');
  }

  // Screenshot
  async screenshot(_options?: { clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer> {
    throw new Error('NativeAppClient.screenshot is not yet implemented');
  }
}
