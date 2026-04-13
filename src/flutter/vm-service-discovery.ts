/**
 * Dart VM Service URL Discovery
 *
 * Discovers the observatory/VM Service URL of a Flutter app running
 * in debug or profile mode on an iOS Simulator. The URL is printed
 * to the system log at launch time.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const VM_SERVICE_URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9_-]+=\//;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Discover the Dart VM Service URL from simulator logs.
 *
 * Strategy:
 * 1. Search recent historical logs for the observatory URL
 * 2. Return null if not found within timeout
 *
 * @param deviceId  Simulator UDID
 * @param options   Discovery options
 * @returns The VM Service HTTP URL, or null if not found
 */
export async function discoverVMServiceUrl(
  deviceId: string,
  options?: { bundleId?: string; timeout?: number },
): Promise<string | null> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Strategy: Search recent logs for observatory URL
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl', 'spawn', deviceId,
      'log', 'show',
      '--predicate', 'eventMessage CONTAINS "Observatory" OR eventMessage CONTAINS "VM service" OR eventMessage CONTAINS "Dart VM service"',
      '--last', '5m',
      '--style', 'compact',
    ], { timeout, maxBuffer: 5 * 1024 * 1024 });

    // Find all URL matches and return the most recent one
    const matches = stdout.match(new RegExp(VM_SERVICE_URL_PATTERN.source, 'g'));
    if (matches && matches.length > 0) {
      return matches[matches.length - 1]; // Most recent
    }
  } catch {
    // Log search failed — try broader search
  }

  // Fallback: broader search without predicate
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl', 'spawn', deviceId,
      'log', 'show',
      '--last', '2m',
      '--style', 'compact',
    ], { timeout, maxBuffer: 10 * 1024 * 1024 });

    const matches = stdout.match(new RegExp(VM_SERVICE_URL_PATTERN.source, 'g'));
    if (matches && matches.length > 0) {
      return matches[matches.length - 1];
    }
  } catch {
    // Broad search also failed
  }

  return null;
}

/**
 * Convert an HTTP observatory URL to its WebSocket equivalent.
 *
 * http://127.0.0.1:50642/abc=/  →  ws://127.0.0.1:50642/abc=/ws
 */
export function httpToWsUrl(httpUrl: string): string {
  const base = httpUrl.replace(/^http/, 'ws').replace(/\/?$/, '');
  return `${base}/ws`;
}

/**
 * Validate that a URL looks like a Dart VM Service URL.
 */
export function isValidVMServiceUrl(url: string): boolean {
  return VM_SERVICE_URL_PATTERN.test(url);
}
