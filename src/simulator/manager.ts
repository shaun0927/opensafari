import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SimctlExecutor } from './simctl';
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

export class SimulatorManager {
  private simctl = new SimctlExecutor();

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
    return devices.find(d => d.udid === deviceId) ?? null;
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

    // Boot
    await this.simctl.exec(['boot', device.udid]);

    // Poll until booted or timeout
    const timeout = options?.timeout ?? DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS;
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < timeout) {
      const current = await this.getDevice(device.udid);
      if (current?.state === 'Booted') {
        return current;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new BootTimeoutError(device.udid, device.name, timeout);
  }

  async shutdown(deviceId: string, options?: { timeout?: number }): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state === 'Shutdown') {
      return; // Already shutdown
    }

    // Graceful shutdown
    try {
      await this.simctl.exec(['shutdown', deviceId]);
    } catch {
      // May already be shutting down
    }

    // Wait for shutdown
    const timeout = options?.timeout ?? DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const current = await this.getDevice(deviceId);
      if (!current || current.state === 'Shutdown') {
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Retry shutdown
    try {
      await this.simctl.exec(['shutdown', deviceId]);
      await new Promise(r => setTimeout(r, 5000));
      const current = await this.getDevice(deviceId);
      if (!current || current.state === 'Shutdown') return;
    } catch {
      // Fall through to erase
    }

    // Nuclear option — erase device (WARNING: deletes all data)
    console.error(`[SimulatorManager] Force erasing device ${deviceId} after shutdown timeout`);
    await this.simctl.exec(['erase', deviceId]);
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
  // Note: simctl has no direct rotate command.
  // Method A: AppleScript (requires Simulator.app GUI)
  // Method B: WebKit Protocol viewport override (Epic 1B fallback)

  async rotate(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device || device.state !== 'Booted') {
      throw new DeviceNotBootedError(deviceId);
    }

    // Try AppleScript rotation via Simulator.app menu
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('osascript', [
        '-e', 'tell application "Simulator" to activate',
        '-e', 'delay 0.5',
        '-e', 'tell application "System Events" to tell process "Simulator" to click menu item "Rotate Left" of menu "Device" of menu bar 1',
      ], { timeout: 10000 });
    } catch {
      // AppleScript may fail in headless/CI environments
      console.error('[SimulatorManager] Rotation via AppleScript failed — use WebKit Protocol viewport override as fallback (Epic 1B)');
    }
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
