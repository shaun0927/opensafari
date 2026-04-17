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

/**
 * Default overall deadline for discovery (ms).
 * Override via OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Minimum allowed value for the env-overridable timeout (ms).
 * Values below this are clamped up to prevent degenerate zero-budget probes.
 */
const MIN_DISCOVERY_TIMEOUT_MS = 500;

/**
 * Per-probe wall-clock cap (ms). Each simctl log probe is bounded to this
 * value so one slow probe cannot consume the entire shared budget. When the
 * caller-supplied total budget exceeds `PROBE_TIMEOUT_MS × 2`, additional
 * probe iterations are scheduled until the deadline is reached (see loop
 * in discoverVMServiceUrl).
 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Default `log show --last` window. Matches the common "already-running app"
 * case where flutter_connect runs well after the launch banner was logged.
 * Override via OPENSAFARI_VM_DISCOVERY_LOG_WINDOW (e.g. "2m", "30m", "1h").
 */
const DEFAULT_LOG_WINDOW = '10m';

const VM_SERVICE_URL_ENV = 'OPENSAFARI_VM_SERVICE_URL';
const VM_SERVICE_WS_URL_ENV = 'OPENSAFARI_VM_SERVICE_WS_URL';
const DISCOVERY_TIMEOUT_ENV = 'OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS';
const DISCOVERY_LOG_WINDOW_ENV = 'OPENSAFARI_VM_DISCOVERY_LOG_WINDOW';

/**
 * Accepts values understood by `log show --last` (e.g. "90s", "5m", "2h").
 * Empty/invalid values fall back to the default.
 */
const LOG_WINDOW_PATTERN = /^\d+\s*[smhd]?$/i;

/**
 * Read and validate the env-overridable discovery deadline.
 * Clamps to MIN_DISCOVERY_TIMEOUT_MS so callers always have a sane budget.
 */
function resolveDiscoveryTimeout(optionOverride?: number): number {
  if (typeof optionOverride === 'number' && optionOverride > 0) {
    return Math.max(optionOverride, MIN_DISCOVERY_TIMEOUT_MS);
  }
  const envRaw = process.env[DISCOVERY_TIMEOUT_ENV];
  if (envRaw !== undefined) {
    const parsed = parseInt(envRaw, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.max(parsed, MIN_DISCOVERY_TIMEOUT_MS);
    }
  }
  return DEFAULT_DISCOVERY_TIMEOUT_MS;
}

/**
 * Read and validate the env-overridable log scan window.
 * Accepts `log show --last` values like "30s", "10m", "2h".
 */
function resolveLogWindow(optionOverride?: string): string {
  const candidate = optionOverride ?? process.env[DISCOVERY_LOG_WINDOW_ENV];
  if (candidate && LOG_WINDOW_PATTERN.test(candidate.trim())) {
    return candidate.trim();
  }
  return DEFAULT_LOG_WINDOW;
}

/**
 * Discover the Dart VM Service URL from simulator logs.
 *
 * Strategy:
 * 1. Short-circuit on env override (no simctl spawned).
 * 2. Predicate-narrowed probe — fast, low-volume, bounded to PROBE_TIMEOUT_MS.
 * 3. Broad fallback probe — only run if probe 1 fails and budget remains.
 * 4. Additional retry iterations — when the caller-supplied total budget
 *    exceeds `PROBE_TIMEOUT_MS × 2`, keep alternating predicate/broad probes
 *    until the shared deadline is reached. This lets larger
 *    OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS values observably extend total runtime
 *    (e.g. slow CI log scans).
 *
 * All probes share a single overall deadline so worst case is one deadline,
 * not N×. When no URL is found within the budget a single error-level log
 * line is emitted and null is returned.
 *
 * @param deviceId  Simulator UDID
 * @param options   Discovery options
 * @returns The VM Service HTTP URL, or null if not found within deadline
 */
export async function discoverVMServiceUrl(
  deviceId: string,
  options?: { bundleId?: string; timeout?: number; logWindow?: string },
): Promise<string | null> {
  const deadlineMs = resolveDiscoveryTimeout(options?.timeout);
  const logWindow = resolveLogWindow(options?.logWindow);

  // Fast path: env override — never touches simctl.
  const envOverride = getEnvOverrideUrl();
  if (envOverride) {
    return envOverride;
  }

  const startedAt = Date.now();
  const absoluteDeadline = startedAt + deadlineMs;

  // Helper: ms remaining until the shared deadline.
  const remaining = () => Math.max(0, absoluteDeadline - Date.now());

  // Helper: run a single simctl log probe. Returns the URL if found, or null.
  const runPredicateProbe = async (budgetMs: number): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl', 'spawn', deviceId,
        'log', 'show',
        '--predicate', 'eventMessage CONTAINS "Observatory" OR eventMessage CONTAINS "VM service" OR eventMessage CONTAINS "Dart VM service"',
        '--last', logWindow,
        '--style', 'compact',
      ], { timeout: budgetMs, maxBuffer: 5 * 1024 * 1024 });

      const matches = stdout.match(new RegExp(VM_SERVICE_URL_PATTERN.source, 'g'));
      if (matches && matches.length > 0) {
        return matches[matches.length - 1]; // Most recent
      }
    } catch {
      // Probe failed (timeout or simctl error).
    }
    return null;
  };

  const runBroadProbe = async (budgetMs: number): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl', 'spawn', deviceId,
        'log', 'show',
        '--last', logWindow,
        '--style', 'compact',
      ], { timeout: budgetMs, maxBuffer: 10 * 1024 * 1024 });

      const matches = stdout.match(new RegExp(VM_SERVICE_URL_PATTERN.source, 'g'));
      if (matches && matches.length > 0) {
        return matches[matches.length - 1];
      }
    } catch {
      // Probe failed.
    }
    return null;
  };

  // Alternate predicate/broad probes until deadline exhausted or URL found.
  // When the total budget is ≤ PROBE_TIMEOUT_MS × 2 this behaves exactly like
  // the original two-probe flow. Larger budgets (e.g. from
  // OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS) get additional retry iterations so the
  // override observably extends total wall time and probe count.
  let iteration = 0;
  while (remaining() > 0) {
    const probeBudget = Math.min(PROBE_TIMEOUT_MS, remaining());
    if (probeBudget <= 0) break;

    // Even iterations use the predicate (fast) probe; odd iterations use the
    // broad fallback. This preserves the original "predicate first, broad
    // second" ordering while allowing further retries under large budgets.
    const url = iteration % 2 === 0
      ? await runPredicateProbe(probeBudget)
      : await runBroadProbe(probeBudget);

    if (url) {
      return url;
    }

    iteration++;
  }

  const elapsedMs = Date.now() - startedAt;
  console.error(
    `[vm-service-discovery] No VM Service URL found within budget (elapsed: ${elapsedMs} ms, deadline: ${deadlineMs} ms, device: ${deviceId})`,
  );
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
