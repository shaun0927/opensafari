/**
 * Simulator lifecycle operations — boot, shutdown, erase, delete, clone.
 *
 * Extracted from SimulatorManager as part of #708 (step 3).
 * All functions take injected dependencies for testability.
 *
 * Behavior is strictly preserved from the original manager:
 *   - Boot: poll every 1 s until device.state === 'Booted' or timeout
 *   - Shutdown: bounded poll, retry once, then erase (nuclear); surfaces
 *     ShutdownTimeoutError if still not down after retry
 *   - Erase/delete/clone: pass-through to simctl; explicit caller intent required
 */

import { SimulatorDevice } from './types';
import { BootTimeoutError, ShutdownTimeoutError } from './errors';
import {
  DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS,
  DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS,
} from '../config/defaults';

/** Minimal simctl interface the lifecycle functions depend on. */
export interface LifecycleSimctl {
  exec(args: string[], options?: { timeout?: number }): Promise<string>;
}

/** Minimal device-lookup interface the lifecycle functions depend on. */
export interface LifecycleDeviceLookup {
  getDevice(deviceId: string): Promise<SimulatorDevice | null>;
  resolveDevice(presetOrId: string): Promise<SimulatorDevice>;
}

/**
 * Boot a simulator identified by preset key or UDID.
 * Returns immediately if already booted.
 * Throws BootTimeoutError if the device does not reach state 'Booted' within
 * the configured timeout.
 */
export async function boot(
  presetOrId: string,
  deps: {
    simctl: LifecycleSimctl;
    lookup: LifecycleDeviceLookup;
    sleep?: (ms: number) => Promise<void>;
    bootTimeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<SimulatorDevice> {
  const {
    simctl,
    lookup,
    sleep = (ms: number) => new Promise(r => setTimeout(r, ms)),
    bootTimeoutMs = DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS,
    pollIntervalMs = 1000,
  } = deps;

  const device = await lookup.resolveDevice(presetOrId);

  // Already booted — return immediately
  if (device.state === 'Booted') {
    return device;
  }

  await simctl.exec(['boot', device.udid]);

  const start = Date.now();
  while (Date.now() - start < bootTimeoutMs) {
    const current = await lookup.getDevice(device.udid);
    if (current?.state === 'Booted') {
      return current;
    }
    await sleep(pollIntervalMs);
  }

  throw new BootTimeoutError(device.udid, device.name, bootTimeoutMs);
}

/**
 * Shut down a simulator by UDID.
 * Returns immediately if the device is already shut down.
 *
 * Strategy (preserving original manager behavior):
 *   1. Issue `simctl shutdown` (graceful).
 *   2. Poll up to `shutdownTimeoutMs` for state === 'Shutdown'.
 *   3. If still booted: retry shutdown, wait 5 s, re-check.
 *   4. If still booted after retry: erase the device (nuclear) and throw
 *      ShutdownTimeoutError so the caller is aware of the escalation.
 *
 * Timeout errors are surfaced — NOT hidden.
 */
export async function shutdown(
  deviceId: string,
  deps: {
    simctl: LifecycleSimctl;
    lookup: LifecycleDeviceLookup;
    sleep?: (ms: number) => Promise<void>;
    shutdownTimeoutMs?: number;
  },
): Promise<void> {
  const {
    simctl,
    lookup,
    sleep = (ms: number) => new Promise(r => setTimeout(r, ms)),
    shutdownTimeoutMs = DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS,
  } = deps;

  const device = await lookup.getDevice(deviceId);
  if (!device || device.state === 'Shutdown') {
    return;
  }

  // Graceful shutdown
  try {
    await simctl.exec(['shutdown', deviceId]);
  } catch {
    // May already be shutting down — continue polling
  }

  // Poll until shutdown
  const start = Date.now();
  while (Date.now() - start < shutdownTimeoutMs) {
    const current = await lookup.getDevice(deviceId);
    if (!current || current.state === 'Shutdown') {
      return;
    }
    await sleep(1000);
  }

  // Retry shutdown once
  try {
    await simctl.exec(['shutdown', deviceId]);
    await sleep(5000);
    const current = await lookup.getDevice(deviceId);
    if (!current || current.state === 'Shutdown') {
      return;
    }
  } catch {
    // Fall through to nuclear erase
  }

  // Nuclear option — erase device (WARNING: deletes all data)
  console.error(`[lifecycle] Force erasing device ${deviceId} after shutdown timeout`);
  await simctl.exec(['erase', deviceId]);
  throw new ShutdownTimeoutError(deviceId, shutdownTimeoutMs);
}

/**
 * Erase a simulator, resetting it to factory state.
 * Requires explicit caller intent — not called implicitly.
 */
export async function eraseDevice(
  deviceId: string,
  deps: { simctl: LifecycleSimctl },
): Promise<void> {
  await deps.simctl.exec(['erase', deviceId]);
}

/**
 * Delete a simulator permanently.
 * Requires explicit caller intent — not called implicitly.
 */
export async function deleteDevice(
  deviceId: string,
  deps: { simctl: LifecycleSimctl },
): Promise<void> {
  await deps.simctl.exec(['delete', deviceId]);
}

/**
 * Clone a simulator by UDID, returning the new device UDID.
 * Note: simctl clone requires the source device to be Shutdown.
 */
export async function cloneDevice(
  deviceId: string,
  cloneName: string,
  deps: { simctl: LifecycleSimctl },
): Promise<string> {
  const output = await deps.simctl.exec(['clone', deviceId, cloneName]);
  return output.trim();
}
