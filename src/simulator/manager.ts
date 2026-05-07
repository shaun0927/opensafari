import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimctlExecutor } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
import { DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';
import { DeviceNotBootedError } from './errors';
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
import {
  launchApp as appManagerLaunchApp,
  terminateApp as appManagerTerminateApp,
  activateApp as appManagerActivateApp,
  listRunningApps as appManagerListRunningApps,
  resetApp as appManagerResetApp,
} from './app-manager';

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
    return appManagerLaunchApp(deviceId, bundleId, options, {
      simctl: this.simctl,
      lookup: this,
    });
  }

  async terminateApp(deviceId: string, bundleId: string): Promise<{ terminated: boolean; bundleId: string; deviceId: string }> {
    return appManagerTerminateApp(deviceId, bundleId, {
      simctl: this.simctl,
      lookup: this,
    });
  }

  async activateApp(deviceId: string, bundleId: string): Promise<{ activated: boolean; bundleId: string; deviceId: string; pid: number }> {
    return appManagerActivateApp(deviceId, bundleId, {
      simctl: this.simctl,
      lookup: this,
    });
  }

  async listRunningApps(deviceId: string): Promise<Array<{ label: string; pid: number }>> {
    return appManagerListRunningApps(deviceId, {
      simctl: this.simctl,
      lookup: this,
    });
  }

  /**
   * Reset app state on a simulator.
   * Strategy: terminate app, reset privacy permissions, clear app data container.
   */
  async resetApp(deviceId: string, bundleId: string): Promise<{ reset: boolean; bundleId: string; deviceId: string; steps: string[] }> {
    return appManagerResetApp(deviceId, bundleId, {
      simctl: this.simctl,
      lookup: this,
    });
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
