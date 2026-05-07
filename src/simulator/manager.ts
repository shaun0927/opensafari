import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SimctlExecutor, SimctlError, SimulatorStateCache, hasBootstatus } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
import { DEVICE_PRESETS } from './presets';
import { DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS, DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS, DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';

interface SimctlListResult {
  devices: Record<string, Array<{
    udid: string;
    name: string;
    state: string;
    isAvailable: boolean;
  }>>;
  runtimes: Array<{
    identifier: string;
    version: string;
    isAvailable: boolean;
    platform: string;
  }>;
}

export interface RotationResult {
  success: boolean;
  method: 'simctl' | 'applescript' | 'none';
  orientation?: string;
}

/**
 * TTL for the per-device state cache inside SimulatorManager.
 * Sized to match the longest polling interval used in this file (1 000 ms) so
 * that multiple callers within a single tick share one `simctl list devices`
 * parse, but the next tick always sees fresh data.
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
    const result = await this.simctl.execJson<SimctlListResult>(['list', 'devices']);
    const devices: SimulatorDevice[] = [];

    for (const [runtimeId, deviceList] of Object.entries(result.devices)) {
      const version = runtimeId.match(/iOS-(\d+)-(\d+)/);
      const runtimeVersion = version ? `${version[1]}.${version[2]}` : 'unknown';

      for (const device of deviceList) {
        if (device.isAvailable) {
          devices.push({
            udid: device.udid,
            name: device.name,
            state: device.state as SimulatorDevice['state'],
            isAvailable: device.isAvailable,
            runtime: runtimeId,
            runtimeVersion,
          });
        }
      }
    }

    return devices;
  }

  async listRuntimes(): Promise<SimulatorRuntime[]> {
    const result = await this.simctl.execJson<SimctlListResult>(['list', 'runtimes']);
    return result.runtimes.filter(r => r.isAvailable);
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
   *   1. Short-lived cache hit — free, shared across concurrent callers.
   *   2. `simctl bootstatus <udid> -b` — narrow command, fast on Xcode 13+.
   *   3. Full `simctl list devices` parse — legacy fallback.
   *
   * The result is placed into the cache so that sibling callers in the same
   * polling tick benefit from the shared read.
   */
  async getDeviceState(deviceId: string): Promise<SimulatorDevice['state'] | null> {
    // 1. Cache hit
    const cached = this.stateCache.get(deviceId);
    if (cached) {
      return cached.state;
    }

    // 2. bootstatus narrow command (Xcode 13+)
    if (await hasBootstatus(this.simctl)) {
      const state = await this.queryBootstatus(deviceId);
      if (state !== null) {
        this.stateCache.set(deviceId, state);
        return state;
      }
    }

    // 3. Full list fallback
    const device = await this.getDevice(deviceId);
    return device?.state ?? null;
  }

  /**
   * Run `simctl bootstatus <udid> -b` and translate the exit code / output
   * into a device state string. Returns null when the device is not found.
   *
   * Exit-code semantics (from simctl man page / source):
   *   0  — device is booted (ready)
   *   A non-zero exit code with output "DeviceNotBootedError" or similar
   *   means the device is not yet booted or is shutting down.
   */
  private async queryBootstatus(deviceId: string): Promise<SimulatorDevice['state'] | null> {
    try {
      await this.simctl.exec(['bootstatus', deviceId, '-b'], { timeout: 5000 });
      if (process.env.DEBUG) {
        console.error(`[SimulatorManager] bootstatus ${deviceId}: Booted`);
      }
      return 'Booted';
    } catch (err) {
      const msg = err instanceof SimctlError ? err.message : String(err);
      if (process.env.DEBUG) {
        console.error(`[SimulatorManager] bootstatus ${deviceId}: not booted (${msg.slice(0, 80)})`);
      }
      // "Unable to look up" / "domain not found" means the UDID does not exist
      if (msg.includes('Unable to lookup') || msg.includes('domain not found') || msg.includes('Invalid device')) {
        return null;
      }
      // Any other error means device exists but is not booted
      return 'Shutdown';
    }
  }

  /**
   * Resolve a preset key or device name to an actual device.
   * Tries: exact UDID match → preset name match → fuzzy name match
   */
  async resolveDevice(presetKey: string): Promise<SimulatorDevice> {
    const devices = await this.listDevices();

    // 1. Exact UDID match
    const byUdid = devices.find(d => d.udid === presetKey);
    if (byUdid) return byUdid;

    // 2. Preset name match
    const preset = DEVICE_PRESETS[presetKey];
    if (preset) {
      const exact = devices.find(d => d.name === preset.name);
      if (exact) return exact;
    }

    // 3. Case-insensitive substring match
    const lower = presetKey.toLowerCase();
    const substring = devices.find(d => d.name.toLowerCase().includes(lower));
    if (substring) return substring;

    // 4. Fuzzy: split words, match all keywords
    const keywords = lower.split(/[\s-]+/);
    const fuzzy = devices.find(d => {
      const dLower = d.name.toLowerCase();
      return keywords.every(kw => dLower.includes(kw));
    });
    if (fuzzy) return fuzzy;

    throw new DeviceNotFoundError(presetKey, devices.map(d => d.name));
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
    const device = await this.resolveDevice(presetOrId);

    // Already booted — return immediately
    if (device.state === 'Booted') {
      return device;
    }

    // Boot — invalidate cache so the polling loop sees fresh state
    await this.simctl.exec(['boot', device.udid]);
    this.stateCache.invalidate(device.udid);

    // Poll until booted or timeout.
    // Uses getDeviceState() which prefers the narrow `bootstatus` command
    // (Xcode 13+) over a full device-list parse on every tick.
    const timeout = options?.timeout ?? DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS;
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < timeout) {
      const state = await this.getDeviceState(device.udid);
      if (state === 'Booted') {
        // Fetch full metadata once for the caller
        const current = await this.getDevice(device.udid);
        return current ?? device;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new BootTimeoutError(device.udid, device.name, timeout);
  }

  async shutdown(deviceId: string, options?: { timeout?: number }): Promise<void> {
    const state = await this.getDeviceState(deviceId);
    if (!state || state === 'Shutdown') {
      return; // Already shut down or device not found
    }

    // Graceful shutdown — invalidate cache so polling sees fresh state
    try {
      await this.simctl.exec(['shutdown', deviceId]);
    } catch {
      // May already be shutting down
    }
    this.stateCache.invalidate(deviceId);

    // Poll until shutdown or timeout.
    // Uses getDeviceState() to avoid parsing the full device list on every tick.
    const timeout = options?.timeout ?? DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const current = await this.getDeviceState(deviceId);
      if (!current || current === 'Shutdown') {
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Timeout reached — retry shutdown once before escalating
    try {
      await this.simctl.exec(['shutdown', deviceId]);
      this.stateCache.invalidate(deviceId);
      await new Promise(r => setTimeout(r, 5000));
      const current = await this.getDeviceState(deviceId);
      if (!current || current === 'Shutdown') return;
    } catch {
      // Fall through to erase
    }

    // Nuclear option — erase device (WARNING: deletes all data)
    console.error(`[SimulatorManager] Force erasing device ${deviceId} after shutdown timeout`);
    await this.simctl.exec(['erase', deviceId]);
    this.stateCache.invalidate(deviceId);
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
    const output = await this.simctl.exec(['clone', deviceId, cloneName]);
    // simctl clone returns the new device UDID
    return output.trim();
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.simctl.exec(['delete', deviceId]);
    this.stateCache.invalidate(deviceId);
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

export class BootTimeoutError extends Error {
  constructor(
    public readonly deviceId: string,
    public readonly deviceName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Simulator boot timeout: "${deviceName}" (${deviceId}) did not boot within ${timeoutMs}ms`);
    this.name = 'BootTimeoutError';
  }
}

export class ShutdownTimeoutError extends Error {
  constructor(
    public readonly deviceId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Simulator shutdown timeout: ${deviceId} did not shutdown within ${timeoutMs}ms`);
    this.name = 'ShutdownTimeoutError';
  }
}

export class DeviceNotFoundError extends Error {
  constructor(
    public readonly requested: string,
    public readonly available: string[],
  ) {
    super(`Device not found: "${requested}". Available: ${available.slice(0, 5).join(', ')}${available.length > 5 ? '...' : ''}`);
    this.name = 'DeviceNotFoundError';
  }
}

export class DeviceNotBootedError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Device ${deviceId} is not booted. Call boot() first.`);
    this.name = 'DeviceNotBootedError';
  }
}

export class ScreenshotTimeoutError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Screenshot capture timed out for device ${deviceId}`);
    this.name = 'ScreenshotTimeoutError';
  }
}

export class AppNotInstalledError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly deviceId: string,
  ) {
    super(`App "${bundleId}" is not installed on device ${deviceId}`);
    this.name = 'AppNotInstalledError';
  }
}

export class AppLaunchError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly deviceId: string,
    public readonly reason: string,
  ) {
    super(`Failed to launch "${bundleId}" on device ${deviceId}: ${reason}`);
    this.name = 'AppLaunchError';
  }
}
