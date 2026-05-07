/**
 * App lifecycle operations — install, launch, terminate, uninstall,
 * activate, list running apps, and reset app state.
 *
 * Extracted from SimulatorManager as part of #708 (step 4).
 * All functions take injected dependencies for testability.
 *
 * Behavior is strictly preserved from the original manager:
 *   - launchApp: maps simctl launch output to pid; surfaces AppNotInstalledError
 *     for "domain not found" / "not installed"; wraps other errors in AppLaunchError.
 *   - terminateApp: returns terminated:false (not error) when app is not running;
 *     surfaces AppNotInstalledError for "domain not found".
 *   - activateApp: uses simctl launch to bring running app to foreground, or
 *     starts it if not running.
 *   - listRunningApps: parses launchctl list UIKitApplication entries.
 *   - resetApp: terminate → privacy reset → uninstall (caller reinstalls).
 */

import { SimctlError } from './simctl';
import { DeviceNotBootedError, AppNotInstalledError, AppLaunchError } from './errors';
import { SimulatorDevice } from './types';

/** Minimal simctl interface the app-manager functions depend on. */
export interface AppManagerSimctl {
  exec(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<string>;
}

/** Minimal device-lookup interface the app-manager functions depend on. */
export interface AppManagerDeviceLookup {
  getDevice(deviceId: string): Promise<SimulatorDevice | null>;
}

/**
 * Launch an app on a booted simulator.
 * Returns the pid parsed from simctl output.
 * Throws DeviceNotBootedError if the device is not booted.
 * Throws AppNotInstalledError if the bundle is not installed.
 * Throws AppLaunchError for any other launch failure.
 */
export async function launchApp(
  deviceId: string,
  bundleId: string,
  options: { args?: string[]; env?: Record<string, string> } | undefined,
  deps: { simctl: AppManagerSimctl; lookup: AppManagerDeviceLookup },
): Promise<{ pid: number; bundleId: string; deviceId: string }> {
  const device = await deps.lookup.getDevice(deviceId);
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
    const output = await deps.simctl.exec(cmdArgs, { env: childEnv });
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

/**
 * Terminate a running app on a booted simulator.
 * Returns terminated:false (not an error) when the app is not running.
 * Throws DeviceNotBootedError if the device is not booted.
 * Throws AppNotInstalledError if the bundle is not installed.
 */
export async function terminateApp(
  deviceId: string,
  bundleId: string,
  deps: { simctl: AppManagerSimctl; lookup: AppManagerDeviceLookup },
): Promise<{ terminated: boolean; bundleId: string; deviceId: string }> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  try {
    await deps.simctl.exec(['terminate', deviceId, bundleId]);
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

/**
 * Activate (bring to foreground) an app on a booted simulator.
 * simctl launch brings an already-running app to the foreground;
 * if the app is not running it starts it.
 * Throws DeviceNotBootedError if the device is not booted.
 * Throws AppNotInstalledError if the bundle is not installed.
 */
export async function activateApp(
  deviceId: string,
  bundleId: string,
  deps: { simctl: AppManagerSimctl; lookup: AppManagerDeviceLookup },
): Promise<{ activated: boolean; bundleId: string; deviceId: string; pid: number }> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  try {
    const output = await deps.simctl.exec(['launch', deviceId, bundleId]);
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

/**
 * List running foreground apps by parsing launchctl list UIKitApplication entries.
 * Throws DeviceNotBootedError if the device is not booted.
 */
export async function listRunningApps(
  deviceId: string,
  deps: { simctl: AppManagerSimctl; lookup: AppManagerDeviceLookup },
): Promise<Array<{ label: string; pid: number }>> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  const output = await deps.simctl.exec(['spawn', deviceId, 'launchctl', 'list']);
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
 * Note: simctl has no "clear data" command; the documented strategy is
 * uninstall + reinstall. We uninstall here; the caller can reinstall.
 * Throws DeviceNotBootedError if the device is not booted.
 * Throws AppNotInstalledError if uninstall confirms the bundle is not installed.
 */
export async function resetApp(
  deviceId: string,
  bundleId: string,
  deps: { simctl: AppManagerSimctl; lookup: AppManagerDeviceLookup },
): Promise<{ reset: boolean; bundleId: string; deviceId: string; steps: string[] }> {
  const device = await deps.lookup.getDevice(deviceId);
  if (!device || device.state !== 'Booted') {
    throw new DeviceNotBootedError(deviceId);
  }

  const steps: string[] = [];

  // Step 1: Terminate the app if running
  try {
    await deps.simctl.exec(['terminate', deviceId, bundleId]);
    steps.push('terminated');
  } catch {
    steps.push('terminate_skipped');
  }

  // Step 2: Reset privacy permissions
  try {
    await deps.simctl.exec(['privacy', deviceId, 'reset', 'all', bundleId]);
    steps.push('privacy_reset');
  } catch {
    steps.push('privacy_reset_skipped');
  }

  // Step 3: Uninstall and note (cannot clear data container directly)
  try {
    await deps.simctl.exec(['uninstall', deviceId, bundleId]);
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
