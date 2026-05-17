import { SimctlExecutor, SimctlError, SimulatorStateCache } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
import {
  listDevices as catalogListDevices,
  listRuntimes as catalogListRuntimes,
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

/**
 * TTL for the per-device state cache inside SimulatorManager.
 * Sized to match the longest polling interval used in the lifecycle module
 * (1000 ms) so that multiple callers within a single tick share one
 * `simctl list devices` parse, but the next tick always sees fresh data.
 */
const STATE_CACHE_TTL_MS = 900;

export class SimulatorManager {
  private simctl = new SimctlExecutor();
  /**
   * Short-lived cache for device states during polling loops.
   * Invalidated immediately on any lifecycle mutation (boot / shutdown / delete).
   */
  private stateCache = new SimulatorStateCache(STATE_CACHE_TTL_MS);

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
    const devices = await this.listDevices();
    const device = devices.find(d => d.udid === deviceId) ?? null;
    if (device) {
      this.stateCache.set(deviceId, device.state);
    }
    return device;
  }

  /**
   * Return the booted/shutdown state of a single device without always
   * parsing the full device list. Used exclusively by polling loops.
   *
   * Strategy (in order of preference):
   *   1. Short-lived cache hit — free, shared across concurrent callers within
   *      the same poll tick.  Skipped when `opts.bypassCache` is true (used by
   *      shutdown polling so it can observe the transient ShuttingDown state).
   *   2. Per-UDID `simctl list devices <udid> -j` — narrow pure-read command
   *      that returns only the JSON for the matching device.  Much cheaper than
   *      the full device-list parse because CoreSimulator filters server-side.
   *
   * The result is placed into the cache so that sibling callers in the same
   * polling tick benefit from the shared read.
   *
   * NOTE: `simctl bootstatus -b` was intentionally NOT used here.  The `-b`
   * flag is a MUTATING operation (boots the device if not already booted) and
   * therefore breaks the read-only contract expected by callers.
   */
  async getDeviceState(
    deviceId: string,
    opts?: { bypassCache?: boolean },
  ): Promise<SimulatorDevice['state'] | null> {
    const bypassCache = opts?.bypassCache === true;

    // 1. Cache hit — shared across concurrent callers within the same tick.
    //    Bypass during shutdown polling so ShuttingDown is always visible.
    if (!bypassCache) {
      const cached = this.stateCache.get(deviceId);
      if (cached) {
        return cached.state;
      }
    }

    // 2. Per-UDID narrow list read — pure, no side-effects.
    //    `simctl list devices <search> -j` filters by the search term
    //    (case-insensitive contains match against the UDID string), so the
    //    returned JSON is much smaller than the full device-list payload.
    const state = await this.queryDeviceStateByUdid(deviceId);
    if (state !== null) {
      this.stateCache.set(deviceId, state);
    }
    return state;
  }

  /**
   * Run `simctl list devices <udid> -j` and extract the state for the given
   * UDID. Returns null when the device is not present in the output.
   *
   * This is a pure read with no side-effects on the simulator.
   */
  private async queryDeviceStateByUdid(deviceId: string): Promise<SimulatorDevice['state'] | null> {
    interface PartialListResult {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    }
    try {
      const result = await this.simctl.execJson<PartialListResult>(['list', 'devices', deviceId]);
      for (const deviceList of Object.values(result.devices)) {
        const entry = deviceList.find(d => d.udid === deviceId);
        if (entry) {
          return entry.state as SimulatorDevice['state'];
        }
      }
      return null;
    } catch (err) {
      if (process.env.DEBUG) {
        const msg = err instanceof SimctlError ? err.message : String(err);
        console.error(`[SimulatorManager] queryDeviceStateByUdid ${deviceId}: error (${msg.slice(0, 80)})`);
      }
      return null;
    }
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
      invalidateCache: udid => this.stateCache.invalidate(udid),
    });
  }

  async shutdown(deviceId: string, options?: { timeout?: number }): Promise<void> {
    return lifecycleShutdown(deviceId, {
      simctl: this.simctl,
      lookup: this,
      shutdownTimeoutMs: options?.timeout,
      invalidateCache: udid => this.stateCache.invalidate(udid),
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
    await lifecycleDeleteDevice(deviceId, { simctl: this.simctl });
    this.stateCache.invalidate(deviceId);
  }

  // === Status Bar Override — business logic in ./ui-controller ===

  async overrideStatusBar(deviceId: string): Promise<void> {
    return uiOverrideStatusBar(deviceId, { simctl: this.simctl, lookup: this });
  }
}
