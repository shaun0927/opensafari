/**
 * Shared utilities for native app interaction tools.
 *
 * These helpers resolve the target simulator device and provide common
 * constants used by app_tap, app_type_text, app_swipe_native, etc.
 */

import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';

/**
 * Resolve the target device UDID from explicit param or the active device.
 * Throws a descriptive error when no device can be determined.
 */
export function resolveDeviceId(params: Record<string, unknown>): string {
  const deviceId =
    (params.deviceId as string | undefined) ||
    getSessionManager().getActiveDeviceId();
  if (!deviceId) {
    throw new Error(
      'No device specified and no active device. Boot a simulator first with device_boot.',
    );
  }
  return deviceId;
}

/** Convenience factory — keeps tool files short. */
export function createSimctl(): SimctlExecutor {
  return new SimctlExecutor();
}

/**
 * USB HID key-code mapping used by `simctl io input keypress`.
 * Values are decimal USB HID usage codes.
 */
export const KEY_MAP: Record<string, string> = {
  return: '40',
  enter: '40',
  escape: '41',
  backspace: '42',
  delete: '42',
  tab: '43',
  space: '44',
  up: '82',
  down: '81',
  left: '80',
  right: '79',
  home: '74',
};
