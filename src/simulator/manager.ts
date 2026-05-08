import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimctlExecutor, SimctlError } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
import { DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';
import {
  DeviceNotBootedError,
  AppNotInstalledError,
  AppLaunchError,
} from './errors';
import {
  listDevices as catalogListDevices,
  listRuntimes as catalogListRuntimes,
  getDevice as catalogGetDevice,
  resolveDevice as catalogResolveDevice,
} from './device-catalog';
import {
  boot as lifecycleBoot,
  shutdown as lifecycleShutdown,
  deleteDevice as lifecycleDeleteDevice,
  cloneDevice as lifecycleCloneDevice,
} from './lifecycle';

// Re-export error classes for backward compatibility — callers should migrate to ./errors
export {
  BootTimeoutError,
  ShutdownTimeoutError,
  DeviceNotFoundError,
  DeviceNotBootedError,
  ScreenshotTimeoutError,
  AppNotInstalledError,
  AppLaunchError,
} from './errors';

export interface RotationResult {
  success: boolean;
  method: 'simctl' | 'applescript' | 'none';
  orientation?: string;
}

export class SimulatorManager {
  private simctl = new SimctlExecutor();

  async listDevices(): Promise<SimulatorDevice[]> {
    return catalogListDevices(this.simctl);
  }

  async listRuntimes(): Promise<SimulatorRuntime[]> {
    return catalogListRuntimes(this.simctl);
  }

  async listBooted(): Promise<SimulatorDevice[]> {
    const devices = await this.listDevices();
    return devices.filter(d => d.state === 'Booted');
  }

  async getDevice(deviceId: string): Promise<SimulatorDevice | null> {
    return catalogGetDevice(this.simctl, deviceId);
  }

  /**
   * Resolve a preset key or device name to an actual device.
   * Tries: exact UDID match → preset name match → fuzzy name match
   */
  async resolveDevice(presetKey: string): Promise<SimulatorDevice> {
    return catalogResolveDevice(this.simctl, presetKey);
  }

  async checkRuntimes(): Promise<{ installed: SimulatorRuntime[]; issues: string[]; suggestions: string[] }> {
    const runtimes = await this.listRuntimes();
    const iosRuntimes = runtimes.filter(r => r.platform === 'iOS');
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (iosRuntimes.length === 0) {
      issues.push('No iOS Simulator runtimes found');
      suggestions.push('Run: xcodebuild -downloadPlatform iOS');
    }

    return { installed: iosRuntimes, issues, suggestions };
  }

  async boot(presetOrId: string, options?: { timeout?: number }): Promise<SimulatorDevice> {
    return lifecycleBoot(presetOrId, {
      simctl: this.simctl,
      lookup: this,
      bootTimeoutMs: options?.timeout,
    });
  }

  async shutdown(deviceId: string, options?: { timeout?: number }): Promise<void> {
    return lifecycleShutdown(deviceId, {
      simctl: this.simctl,
      lookup: this,
      shutdownTimeoutMs: options?.timeout,
    });
  }

  async bootPreset(presetKey: string): Promise<SimulatorDevice> {
    return this.boot(presetKey);
  }

  async openUrl(deviceId: string, url: string): Promise<void> {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // Check device is booted
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    await this.simctl.exec(['openurl', deviceId, url]);
    // Brief wait for Safari to start processing
    await new Promise(r => setTimeout(r, 1000));
  }

  async screenshot(deviceId: string, options?: { format?: 'png' | 'jpeg' }): Promise<Buffer> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    const format = options?.format ?? 'png';
    const tmpFile = path.join(os.tmpdir(), `opensafari-screenshot-${randomUUID()}.${format}`);

    try {
      await this.simctl.exec(
        ['io', deviceId, 'screenshot', `--type=${format}`, tmpFile],
        { timeout: DEFAULT_SCREENSHOT_TIMEOUT_MS }
      );
      const buffer = await fs.readFile(tmpFile);
      return buffer;
    } finally {
      // Cleanup temp file
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  async screenshotBase64(deviceId: string, options?: { format?: 'png' | 'jpeg' }): Promise<string> {
    const buffer = await this.screenshot(deviceId, options);
    return buffer.toString('base64');
  }

  // === App Lifecycle ===

  async launchApp(
    deviceId: string,
    bundleId: string,
    options?: { args?: string[]; env?: Record<string, string> },
  ): Promise<{ pid: number; bundleId: string; deviceId: string }> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    const cmdArgs = ['launch', deviceId, bundleId];
    if (options?.args) {
      cmdArgs.push(...options.args);
    }

    // simctl passes SIMCTL_CHILD_* env vars to the launched app
    const childEnv: Record<string, string> = {};
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        childEnv[`SIMCTL_CHILD_${key}`] = value;
      }
    }

    try {
      const output = await this.simctl.exec(cmdArgs, { env: childEnv });
      const pidMatch = output.match(/:\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : -1;
      return { pid, bundleId, deviceId };
    } catch (err) {
      if (err instanceof SimctlError) {
        if (err.message.includes('domain not found') || err.message.includes('not installed')) {
          throw new AppNotInstalledError(bundleId, deviceId);
        }
      }
      throw new AppLaunchError(bundleId, deviceId, err instanceof Error ? err.message : String(err));
    }
  }

  async terminateApp(deviceId: string, bundleId: string): Promise<{ terminated: boolean; bundleId: string; deviceId: string }> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    try {
      await this.simctl.exec(['terminate', deviceId, bundleId]);
      return { terminated: true, bundleId, deviceId };
    } catch (err) {
      if (err instanceof SimctlError) {
        if (err.message.includes('not running') || err.message.includes('Failed to terminate')) {
          return { terminated: false, bundleId, deviceId };
        }
        if (err.message.includes('domain not found') || err.message.includes('not installed')) {
          throw new AppNotInstalledError(bundleId, deviceId);
        }
      }
      throw err;
    }
  }

  async activateApp(deviceId: string, bundleId: string): Promise<{ activated: boolean; bundleId: string; deviceId: string; pid: number }> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    // simctl launch brings an already-running app to the foreground;
    // if the app is not running it starts it.
    try {
      const output = await this.simctl.exec(['launch', deviceId, bundleId]);
      const pidMatch = output.match(/:\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : -1;
      return { activated: true, bundleId, deviceId, pid };
    } catch (err) {
      if (err instanceof SimctlError) {
        if (err.message.includes('domain not found') || err.message.includes('not installed')) {
          throw new AppNotInstalledError(bundleId, deviceId);
        }
      }
      throw err;
    }
  }

  async listRunningApps(deviceId: string): Promise<Array<{ label: string; pid: number }>> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    const output = await this.simctl.exec(['spawn', deviceId, 'launchctl', 'list']);
    const lines = output.split('\n');
    const apps: Array<{ label: string; pid: number }> = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const label = parts[2];
      // Filter for UIKitApplication entries (running foreground apps)
      if (!isNaN(pid) && pid > 0 && label.startsWith('UIKitApplication:')) {
        const bundleId = label.replace('UIKitApplication:', '').replace(/\[.*\]$/, '');
        apps.push({ label: bundleId, pid });
      }
    }

    return apps;
  }

  /**
   * Reset app state on a simulator.
   * Strategy: terminate app, reset privacy permissions, clear app data container.
   */
  async resetApp(deviceId: string, bundleId: string): Promise<{ reset: boolean; bundleId: string; deviceId: string; steps: string[] }> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    const steps: string[] = [];

    // Step 1: Terminate the app if running
    try {
      await this.simctl.exec(['terminate', deviceId, bundleId]);
      steps.push('terminated');
    } catch {
      steps.push('terminate_skipped');
    }

    // Step 2: Reset privacy permissions
    try {
      await this.simctl.exec(['privacy', deviceId, 'reset', 'all', bundleId]);
      steps.push('privacy_reset');
    } catch {
      steps.push('privacy_reset_skipped');
    }

    // Step 3: Uninstall and note (cannot clear data container directly)
    // simctl has no "clear data" command; the documented strategy is
    // uninstall + reinstall. We uninstall here; the caller can reinstall.
    try {
      await this.simctl.exec(['uninstall', deviceId, bundleId]);
      steps.push('uninstalled');
    } catch (err) {
      if (err instanceof SimctlError) {
        if (err.message.includes('domain not found') || err.message.includes('not installed')) {
          throw new AppNotInstalledError(bundleId, deviceId);
        }
      }
      steps.push('uninstall_failed');
    }

    return { reset: true, bundleId, deviceId, steps };
  }

  // Expose simctl for direct use by other methods
  getSimctl(): SimctlExecutor {
    return this.simctl;
  }

  // === Appearance (Dark/Light Mode) ===

  async setAppearance(deviceId: string, mode: 'light' | 'dark'): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }
    await this.simctl.exec(['ui', deviceId, 'appearance', mode]);
  }

  async getAppearance(deviceId: string): Promise<'light' | 'dark'> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }
    const output = await this.simctl.exec(['ui', deviceId, 'appearance']);
    return output.trim().toLowerCase() === 'dark' ? 'dark' : 'light';
  }

  async toggleAppearance(deviceId: string): Promise<'light' | 'dark'> {
    const current = await this.getAppearance(deviceId);
    const next = current === 'light' ? 'dark' : 'light';
    await this.setAppearance(deviceId, next);
    return next;
  }

  // === Rotation ===
  // Method A: simctl io setorientation (works in headless/CI)
  // Method B: AppleScript (requires Simulator.app GUI)

  async rotate(deviceId: string, direction: 'left' | 'right' = 'left'): Promise<RotationResult> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    const orientation = direction === 'left' ? 'landscapeLeft' : 'landscapeRight';

    // Try simctl first (works in headless/CI)
    try {
      const execFileAsync = promisify(execFile);
      await execFileAsync('xcrun', ['simctl', 'io', deviceId, 'setorientation', orientation], { timeout: 10000 });
      return { success: true, method: 'simctl', orientation };
    } catch {
      console.error('[SimulatorManager] simctl setorientation not available, trying AppleScript');
    }

    // Fallback to AppleScript (requires GUI)
    try {
      const execFileAsync = promisify(execFile);
      const menuItem = direction === 'left' ? 'Rotate Left' : 'Rotate Right';
      await execFileAsync('osascript', [
        '-e', 'tell application "Simulator" to activate',
        '-e', 'delay 0.5',
        '-e', `tell application "System Events" to tell process "Simulator" to click menu item "${menuItem}" of menu "Device" of menu bar 1`,
      ], { timeout: 10000 });
      return { success: true, method: 'applescript', orientation };
    } catch {
      console.error('[SimulatorManager] Rotation via AppleScript also failed — no rotation method available');
    }

    return { success: false, method: 'none' };
  }

  // === Device Clone (state persistence alternative) ===
  // Note: simctl snapshot save/restore does NOT exist.
  // simctl clone creates a full device copy with a new UDID.

  async cloneDevice(deviceId: string, cloneName: string): Promise<string> {
    return lifecycleCloneDevice(deviceId, cloneName, { simctl: this.simctl });
  }

  async deleteDevice(deviceId: string): Promise<void> {
    return lifecycleDeleteDevice(deviceId, { simctl: this.simctl });
  }

  // === Status Bar Override (for deterministic screenshots) ===

  async overrideStatusBar(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }
    await this.simctl.exec([
      'status_bar', deviceId, 'override',
      '--time', '9:41',
      '--batteryLevel', '100',
      '--cellularBars', '4',
    ]);
  }
}
