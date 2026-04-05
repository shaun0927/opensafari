/**
 * SimctlNativeBackend — v1 implementation of NativeAppBackend using xcrun simctl.
 *
 * Covers lifecycle, permissions, deep links, push notifications, screenshots,
 * and logs. Accessibility and interaction methods are stubbed for v1.5/v2.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SimctlExecutor } from '../simulator/simctl';
import { NotImplementedError } from './backend';
import type { NativeAppBackend } from './backend';
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

const DEFAULT_DEVICE = 'booted';

export class SimctlNativeBackend implements NativeAppBackend {
  private simctl: SimctlExecutor;

  constructor(simctl?: SimctlExecutor) {
    this.simctl = simctl ?? new SimctlExecutor();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async launch(bundleId: string, options?: AppLaunchOptions): Promise<AppProcessInfo> {
    const deviceId = options?.deviceId ?? DEFAULT_DEVICE;
    const args: string[] = ['launch', deviceId, bundleId];

    if (options?.environment) {
      for (const [key, value] of Object.entries(options.environment)) {
        args.push(`SIMCTL_CHILD_${key}=${value}`);
      }
    }

    if (options?.arguments) {
      args.push(...options.arguments);
    }

    const output = await this.simctl.exec(args);

    // simctl launch prints "<bundleId>: <pid>\n" on success
    const pidMatch = output.match(/:\s*(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;

    return { bundleId, pid, deviceId };
  }

  async terminate(bundleId: string, deviceId?: string): Promise<void> {
    await this.simctl.exec(['terminate', deviceId ?? DEFAULT_DEVICE, bundleId]);
  }

  async listApps(deviceId?: string): Promise<AppInfo[]> {
    const output = await this.simctl.exec(['listapps', deviceId ?? DEFAULT_DEVICE, '-j']);
    let parsed: Record<string, unknown>[];
    try {
      parsed = JSON.parse(output) as Record<string, unknown>[];
    } catch {
      // Fallback: simctl listapps may output plist-style data on older Xcode
      console.error('[native] Failed to parse listapps JSON output, returning empty list');
      return [];
    }

    return parsed.map((app) => ({
      bundleId: String(app['CFBundleIdentifier'] ?? ''),
      displayName: String(app['CFBundleDisplayName'] ?? app['CFBundleName'] ?? ''),
      version: app['CFBundleShortVersionString'] ? String(app['CFBundleShortVersionString']) : undefined,
      bundlePath: app['Path'] ? String(app['Path']) : undefined,
    }));
  }

  // ── Inspection (v1.5 stubs) ────────────────────────────────────

  async getAccessibilityTree(_options?: TreeOptions): Promise<AccessibilityNode> {
    throw new NotImplementedError(
      'getAccessibilityTree',
      'Accessibility tree retrieval requires the XCTest bridge (planned for v1.5). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  async queryElements(_selector: string, _strategy?: QueryStrategy): Promise<AccessibilityNode[]> {
    throw new NotImplementedError(
      'queryElements',
      'Element querying requires the XCTest bridge (planned for v1.5). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  // ── Interaction (v2 stubs) ─────────────────────────────────────

  async tap(_target: ElementTarget, _options?: TapOptions): Promise<void> {
    throw new NotImplementedError(
      'tap',
      'Tap interaction requires the XCTest bridge or WebDriverAgent (planned for v2). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  async typeText(_target: ElementTarget, _text: string, _options?: TypeOptions): Promise<void> {
    throw new NotImplementedError(
      'typeText',
      'Text input requires the XCTest bridge or WebDriverAgent (planned for v2). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  async swipe(_direction: SwipeDirection, _options?: SwipeOptions): Promise<void> {
    throw new NotImplementedError(
      'swipe',
      'Swipe gestures require the XCTest bridge or WebDriverAgent (planned for v2). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  // ── System ─────────────────────────────────────────────────────

  async handleAlert(_action: AlertAction, _buttonText?: string): Promise<AlertResult> {
    throw new NotImplementedError(
      'handleAlert',
      'Alert handling requires the XCTest bridge (planned for v1.5). ' +
      'See docs/native-app-mode-rfc.md for the roadmap.',
    );
  }

  async setPermission(
    permission: string,
    value: PermissionValue,
    bundleId: string,
    deviceId?: string,
  ): Promise<void> {
    const action = value === 'grant' ? 'grant' : value === 'revoke' ? 'revoke' : 'reset';
    await this.simctl.exec([
      'privacy',
      deviceId ?? DEFAULT_DEVICE,
      action,
      permission,
      bundleId,
    ]);
  }

  async openUrl(url: string, deviceId?: string): Promise<void> {
    await this.simctl.exec(['openurl', deviceId ?? DEFAULT_DEVICE, url]);
  }

  async sendPushNotification(
    bundleId: string,
    payload: Record<string, unknown>,
    deviceId?: string,
  ): Promise<void> {
    // simctl push requires a JSON file, so we write a temp file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-push-'));
    const payloadPath = path.join(tmpDir, 'payload.json');

    try {
      await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), 'utf-8');
      await this.simctl.exec([
        'push',
        deviceId ?? DEFAULT_DEVICE,
        bundleId,
        payloadPath,
      ]);
    } finally {
      // Clean up temp file
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      });
    }
  }

  // ── Observability ──────────────────────────────────────────────

  async captureScreenshot(deviceId?: string): Promise<Buffer> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-screenshot-'));
    const screenshotPath = path.join(tmpDir, 'screenshot.png');

    try {
      await this.simctl.exec([
        'io',
        deviceId ?? DEFAULT_DEVICE,
        'screenshot',
        screenshotPath,
      ]);
      return await fs.readFile(screenshotPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      });
    }
  }

  async getLogs(options?: LogOptions): Promise<LogEntry[]> {
    const deviceId = options?.deviceId ?? DEFAULT_DEVICE;
    const args: string[] = ['spawn', deviceId, 'log', 'show', '--style', 'json'];

    if (options?.bundleId) {
      args.push('--predicate', `process == "${options.bundleId}"`);
    }

    if (options?.since) {
      args.push('--start', options.since);
    }

    if (options?.level) {
      args.push('--predicate', `messageType == ${logLevelToInt(options.level)}`);
    }

    const output = await this.simctl.exec(args, { timeout: 15000 });

    let entries: LogEntry[];
    try {
      const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
      entries = parsed.map((entry) => ({
        timestamp: String(entry['timestamp'] ?? ''),
        level: String(entry['messageType'] ?? 'info'),
        process: String(entry['processImagePath'] ?? entry['process'] ?? ''),
        message: String(entry['eventMessage'] ?? ''),
      }));
    } catch {
      // If JSON parsing fails, return raw output as a single entry
      entries = [{
        timestamp: new Date().toISOString(),
        level: 'info',
        process: options?.bundleId ?? 'unknown',
        message: output,
      }];
    }

    if (options?.lines && entries.length > options.lines) {
      entries = entries.slice(-options.lines);
    }

    return entries;
  }
}

/** Map log level names to os_log integer types. */
function logLevelToInt(level: string): number {
  switch (level) {
    case 'debug': return 0;
    case 'info': return 1;
    case 'error': return 16;
    case 'fault': return 17;
    default: return 1;
  }
}
