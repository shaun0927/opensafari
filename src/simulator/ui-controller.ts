/**
 * UI / display operations for the iOS Simulator.
 *
 * Extracted from SimulatorManager as part of #708 (step 5 — final).
 * All functions take injected dependencies for testability.
 *
 * Behavior is strictly preserved from the original manager:
 *   - screenshot: captures via `simctl io screenshot`; no transient retry here —
 *     the transient-retry pattern (PR #658) lives in src/tools/app-screenshot-native.ts
 *     which wraps this at the MCP tool layer.
 *   - screenshotBase64: thin wrapper that base64-encodes the screenshot buffer.
 *   - setAppearance / getAppearance / toggleAppearance: delegate to `simctl ui appearance`.
 *   - rotate: tries `simctl io setorientation` first; falls back to AppleScript GUI.
 *   - overrideStatusBar: sets deterministic status bar values via `simctl status_bar`.
 *   - openUrl: validates URL, checks device is booted, calls `simctl openurl`.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DeviceNotBootedError } from './errors';
import { SimulatorDevice } from './types';
import { DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';

/** Minimal simctl interface the UI-controller functions depend on. */
export interface UiControllerSimctl {
  exec(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<string>;
}

/** Minimal device-lookup interface the UI-controller functions depend on. */
export interface UiControllerDeviceLookup {
  getDevice(deviceId: string): Promise<SimulatorDevice | null>;
}

export interface RotationResult {
  success: boolean;
  method: 'simctl' | 'applescript' | 'none';
  orientation?: string;
}

/**
 * Capture a screenshot of a booted simulator.
 * Writes to a temp file via `simctl io screenshot`, reads the buffer, then cleans up.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function screenshot(
  deviceId: string,
  options: { format?: 'png' | 'jpeg' } | undefined,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<Buffer> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  const format = options?.format ?? 'png';
  const tmpFile = path.join(os.tmpdir(), `opensafari-screenshot-${randomUUID()}.${format}`);

  try {
    await deps.simctl.exec(
      ['io', deviceId, 'screenshot', `--type=${format}`, tmpFile],
      { timeout: DEFAULT_SCREENSHOT_TIMEOUT_MS },
    );
    const buffer = await fs.readFile(tmpFile);
    return buffer;
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Capture a screenshot and return it as a base64-encoded string.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function screenshotBase64(
  deviceId: string,
  options: { format?: 'png' | 'jpeg' } | undefined,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<string> {
  const buf = await screenshot(deviceId, options, deps);
  return buf.toString('base64');
}

/**
 * Set the appearance (light/dark mode) of a booted simulator.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function setAppearance(
  deviceId: string,
  mode: 'light' | 'dark',
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<void> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }
  await deps.simctl.exec(['ui', deviceId, 'appearance', mode]);
}

/**
 * Get the current appearance (light/dark mode) of a booted simulator.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function getAppearance(
  deviceId: string,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<'light' | 'dark'> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }
  const output = await deps.simctl.exec(['ui', deviceId, 'appearance']);
  return output.trim().toLowerCase() === 'dark' ? 'dark' : 'light';
}

/**
 * Toggle the appearance between light and dark.
 * Returns the new appearance value.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function toggleAppearance(
  deviceId: string,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<'light' | 'dark'> {
  const current = await getAppearance(deviceId, deps);
  const next = current === 'light' ? 'dark' : 'light';
  await setAppearance(deviceId, next, deps);
  return next;
}

/**
 * Rotate a booted simulator.
 * Method A: `simctl io setorientation` (works in headless/CI).
 * Method B: AppleScript (requires Simulator.app GUI).
 * Returns a RotationResult describing which method succeeded (or 'none').
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function rotate(
  deviceId: string,
  direction: 'left' | 'right',
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<RotationResult> {
  const device = await deps.lookup.getDevice(deviceId);
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
    console.error('[UiController] simctl setorientation not available, trying AppleScript');
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
    console.error('[UiController] Rotation via AppleScript also failed — no rotation method available');
  }

  return { success: false, method: 'none' };
}

/**
 * Override the status bar to deterministic values (useful for screenshots).
 * Sets: time=9:41, batteryLevel=100, cellularBars=4.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function overrideStatusBar(
  deviceId: string,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<void> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }
  await deps.simctl.exec([
    'status_bar', deviceId, 'override',
    '--time', '9:41',
    '--batteryLevel', '100',
    '--cellularBars', '4',
  ]);
}

/**
 * Open a URL in Safari on a booted simulator.
 * Validates the URL, checks the device is booted, then calls `simctl openurl`.
 * Waits briefly for Safari to start processing.
 * Throws an Error for invalid URLs.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function openUrl(
  deviceId: string,
  url: string,
  deps: { simctl: UiControllerSimctl; lookup: UiControllerDeviceLookup },
): Promise<void> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  await deps.simctl.exec(['openurl', deviceId, url]);
  // Brief wait for Safari to start processing
  await new Promise(r => setTimeout(r, 1000));
}
