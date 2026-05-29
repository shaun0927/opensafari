/**
 * Shared utilities for native app observability tools.
 */

import { getSessionManager } from '../session-manager';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ErrorCode, StructuredErrorException } from '../errors';

/**
 * Resolve device ID from params or the active device in the session.
 * Throws if no device is available.
 */
export function resolveDeviceId(params: Record<string, unknown>): string {
  const deviceId = (params.deviceId as string) || getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first with device_boot.');
  }
  return deviceId;
}

/**
 * Generate a temp file path with the given extension.
 */
export function tempPath(ext: string): string {
  return path.join(os.tmpdir(), `opensafari-${randomUUID()}.${ext}`);
}

/**
 * Parse a human-readable duration string to the format accepted by `log show --last`.
 * Accepts: "5m", "1h", "30s", "2d". log show accepts these directly.
 */
export function parseDuration(duration: string): string {
  // log show --last accepts formats like 1m, 5m, 1h, 30s directly
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected format like "5m", "1h", "30s".`);
  }
  return duration;
}
