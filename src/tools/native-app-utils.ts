import { getSessionManager } from '../session-manager';

/**
 * Resolve a device ID from tool params or fall back to the active device.
 * Throws if no device is available.
 */
export function resolveDeviceId(params: Record<string, unknown>): string {
  const deviceId = (params.deviceId as string) || getSessionManager().getActiveDeviceId();
  if (!deviceId) {
    throw new Error(
      'No device specified and no active device. Boot a simulator first with device_boot.',
    );
  }
  return deviceId;
}
