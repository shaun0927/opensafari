/**
 * Dart VM Service URL Discovery
 *
 * Discovers the observatory/VM Service URL of a Flutter app running
 * in debug or profile mode on an iOS Simulator. The URL is printed
 * to the system log at launch time.
 */

import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const VM_SERVICE_URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9_-]+=\//;
const DEFAULT_TIMEOUT_MS = 10000;
const VM_SERVICE_URL_ENV = 'OPENSAFARI_VM_SERVICE_URL';
const VM_SERVICE_WS_URL_ENV = 'OPENSAFARI_VM_SERVICE_WS_URL';

/**
 * Per-device cache of the most recent VM Service URL that successfully
 * completed a `connect()` handshake. Used as a hot path so subsequent
 * `flutter_connect` calls within the same simulator session can skip the
 * expensive `simctl spawn log show` scan (~1-3s) as long as the URL still
 * responds to a cheap HTTP probe.
 */
const urlCache = new Map<string, string>();

export function rememberVMServiceUrl(deviceId: string, httpUrl: string): void {
  if (!isValidVMServiceUrl(httpUrl)) return;
  urlCache.set(deviceId, httpUrl);
}

export function forgetVMServiceUrl(deviceId: string): void {
  urlCache.delete(deviceId);
}

export function getCachedVMServiceUrl(deviceId: string): string | undefined {
  return urlCache.get(deviceId);
}

/**
 * Quick HEAD/GET probe against the cached VM Service URL. The Dart VM Service
 * HTTP root returns a 200 with `application/json` (`{}`) when the auth token
 * matches and the isolate is alive. Returns true within ~200 ms when the URL
 * is still serving, false on any error.
 */
export function probeVMServiceUrl(httpUrl: string, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const req = http.get(httpUrl, { timeout: timeoutMs }, (res) => {
        // Dart VM Service replies 200 with empty JSON on the root.
        // Any 2xx/3xx confirms the port is alive and the token still matches.
        const status = res.statusCode ?? 0;
        res.resume();
        finish(status >= 200 && status < 400);
      });
      req.on('timeout', () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

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
  options?: { bundleId?: string; timeout?: number; skipCache?: boolean },
): Promise<string | null> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const envOverride = getEnvOverrideUrl();
  if (envOverride) {
    return envOverride;
  }

  // Hot path: if a prior connect succeeded for this device, try that URL
  // first via a cheap HTTP probe. Saves the 1-3 s `simctl log show` scan
  // when the VM Service is still up — common when the WebSocket dropped due
  // to a transient ios-webkit-debug-proxy restart or a simulator sleep/wake.
  if (!options?.skipCache) {
    const cached = urlCache.get(deviceId);
    if (cached && isValidVMServiceUrl(cached)) {
      try {
        if (await probeVMServiceUrl(cached)) {
          return cached;
        }
      } catch {
        // probe failed — fall through to fresh discovery
      }
      // stale: drop so a parallel caller doesn't probe again
      urlCache.delete(deviceId);
    }
  }

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
 * Convert a VM Service WebSocket URL to its HTTP equivalent.
 *
 * ws://127.0.0.1:50642/abc=/ws  →  http://127.0.0.1:50642/abc=/
 */
export function wsToHttpUrl(wsUrl: string): string {
  const base = wsUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '/');
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Validate that a URL looks like a Dart VM Service URL.
 */
export function isValidVMServiceUrl(url: string): boolean {
  return VM_SERVICE_URL_PATTERN.test(url);
}

function getEnvOverrideUrl(): string | null {
  const httpUrl = process.env[VM_SERVICE_URL_ENV];
  if (httpUrl && isValidVMServiceUrl(httpUrl)) {
    return httpUrl;
  }

  const wsUrl = process.env[VM_SERVICE_WS_URL_ENV];
  if (wsUrl) {
    const normalized = wsToHttpUrl(wsUrl);
    if (isValidVMServiceUrl(normalized)) {
      return normalized;
    }
  }

  return null;
}
