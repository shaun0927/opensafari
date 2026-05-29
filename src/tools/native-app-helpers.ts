import { getSessionManager } from '../session-manager';
import { ErrorCode, StructuredErrorException } from '../errors';

/**
 * Resolve device ID from params or fall back to the active device.
 * Throws if no device is available.
 */
export function resolveDeviceId(params: Record<string, unknown>): string {
  const deviceId = (params.deviceId as string) || getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first with device_boot.');
  }
  return deviceId;
}
