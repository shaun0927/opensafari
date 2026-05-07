import { SimctlExecutor } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
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
import {
  screenshot as uiScreenshot,
  screenshotBase64 as uiScreenshotBase64,
  setAppearance as uiSetAppearance,
  getAppearance as uiGetAppearance,
  toggleAppearance as uiToggleAppearance,
  rotate as uiRotate,
  overrideStatusBar as uiOverrideStatusBar,
  openUrl as uiOpenUrl,
  type RotationResult,
} from './ui-controller';

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

// Re-export RotationResult from ui-controller for backward compatibility
export type { RotationResult } from './ui-controller';

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

  // Business logic lives in ./ui-controller
  async openUrl(deviceId: string, url: string): Promise<void> {
    return uiOpenUrl(deviceId, url, { simctl: this.simctl, lookup: this });
  }

  // Business logic lives in ./ui-controller
  async screenshot(deviceId: string, options?: { format?: 'png' | 'jpeg' }): Promise<Buffer> {
    return uiScreenshot(deviceId, options, { simctl: this.simctl, lookup: this });
  }

  async screenshotBase64(deviceId: string, options?: { format?: 'png' | 'jpeg' }): Promise<string> {
    return uiScreenshotBase64(deviceId, options, { simctl: this.simctl, lookup: this });
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

  // === Appearance (Dark/Light Mode) — business logic in ./ui-controller ===

  async setAppearance(deviceId: string, mode: 'light' | 'dark'): Promise<void> {
    return uiSetAppearance(deviceId, mode, { simctl: this.simctl, lookup: this });
  }

  async getAppearance(deviceId: string): Promise<'light' | 'dark'> {
    return uiGetAppearance(deviceId, { simctl: this.simctl, lookup: this });
  }

  async toggleAppearance(deviceId: string): Promise<'light' | 'dark'> {
    return uiToggleAppearance(deviceId, { simctl: this.simctl, lookup: this });
  }

  // === Rotation — business logic in ./ui-controller ===

  async rotate(deviceId: string, direction: 'left' | 'right' = 'left'): Promise<RotationResult> {
    return uiRotate(deviceId, direction, { simctl: this.simctl, lookup: this });
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

  // === Status Bar Override — business logic in ./ui-controller ===

  async overrideStatusBar(deviceId: string): Promise<void> {
    return uiOverrideStatusBar(deviceId, { simctl: this.simctl, lookup: this });
  }
}
