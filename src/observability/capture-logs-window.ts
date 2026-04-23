/**
 * capture-logs-window — capture `os_log` entries around a URL-open event so a
 * caller can verify in one round-trip that the deep-link handler fired (e.g.
 * `[UniversalLink] Resolved …`) without juggling `xcrun simctl log stream` by
 * hand.
 *
 * iOS does not expose a kernel "app is quiescent" signal outside of
 * Instruments / `dt_probe`, so we use a silence heuristic: keep fetching logs
 * in the window `[preOpenTimestamp - prerollMs, now]`, and stop once no new
 * matching entry has arrived for `silenceMs` (or we hit `maxDurationMs`).
 *
 * The shape mirrors the NSPredicate builder already used by `app_logs` so the
 * filter semantics (bundleId, level, search) line up across tools.
 */

import { SimctlExecutor } from '../simulator/simctl';
import { buildLogPredicate } from '../tools/app-logs';

export interface CaptureLogsOptions {
  /** Process filter (`process == <bundleId>`). */
  bundleId?: string;
  /** Minimum message severity. */
  level?: 'default' | 'info' | 'debug' | 'error' | 'fault';
  /** Substring filter applied to the composed message. */
  search?: string;
  /** How far back to pull logs relative to `preOpenAt`. Default 2000 ms. */
  prerollMs?: number;
  /** Stop once this many ms elapse with no new matching entry. Default 1500 ms. */
  silenceMs?: number;
  /** Hard upper bound on the collection window. Default 8000 ms. */
  maxDurationMs?: number;
  /** Poll cadence. Default 400 ms. */
  pollIntervalMs?: number;
}

export interface CaptureLogsResult {
  entries: Array<Record<string, unknown>>;
  windowStart: string;
  windowEnd: string;
  truncated: false;
  stopReason: 'silence' | 'max_duration';
}

export interface CaptureLogsError {
  error: string;
  stopReason: 'error';
  windowStart: string;
  windowEnd: string;
}

export interface CaptureLogsDeps {
  simctl?: SimctlExecutor;
  /** Injected now() for tests. */
  now?: () => number;
  /** Injected sleep() for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PREROLL_MS = 2000;
const DEFAULT_SILENCE_MS = 1500;
const DEFAULT_MAX_DURATION_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 400;

/**
 * Capture unified-log entries around a URL-open event.
 *
 * `preOpenAt` must be captured by the caller **before** invoking
 * `simctl openurl` so the preroll covers logs emitted by the URL tap itself.
 */
export async function captureLogsWindow(
  deviceId: string,
  preOpenAt: number,
  opts: CaptureLogsOptions = {},
  deps: CaptureLogsDeps = {},
): Promise<CaptureLogsResult | CaptureLogsError> {
  const simctl = deps.simctl ?? new SimctlExecutor();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const prerollMs = positive(opts.prerollMs, DEFAULT_PREROLL_MS);
  const silenceMs = positive(opts.silenceMs, DEFAULT_SILENCE_MS);
  const maxDurationMs = positive(opts.maxDurationMs, DEFAULT_MAX_DURATION_MS);
  const pollIntervalMs = positive(opts.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);

  const windowStartMs = preOpenAt - prerollMs;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const predicate = buildLogPredicate({
    bundleId: opts.bundleId,
    level: opts.level,
    search: opts.search,
  });

  const collected: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  // Anchor silence and max-duration on capture start, NOT on preOpenAt.
  // preOpenAt is recorded before `simctl openurl`, so seeding either timer
  // with it would charge the caller for however long the URL took to open:
  // if openurl exceeded `silenceMs` (1500ms default), the very first poll
  // would trip the silence exit and return 0 entries before we had a chance
  // to observe any post-open log. `windowStart` still uses `preOpenAt -
  // prerollMs` so the log *query* range covers the tap itself.
  const captureStart = now();
  let lastNewEntryAt = captureStart;
  let stopReason: 'silence' | 'max_duration' = 'silence';

  const deadline = captureStart + maxDurationMs;

  while (true) {
    const startArg = formatStartTime(windowStartMs);
    const args: string[] = [
      'spawn',
      deviceId,
      'log',
      'show',
      '--start',
      startArg,
      '--style',
      'json',
    ];
    if (predicate) {
      args.push('--predicate', predicate);
    }

    let output: string;
    try {
      output = await simctl.exec(args, { timeout: 15000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: message,
        stopReason: 'error',
        windowStart: windowStartIso,
        windowEnd: new Date(now()).toISOString(),
      };
    }

    const parsed = parseLogOutput(output);
    let addedThisPoll = 0;
    for (const entry of parsed) {
      const key = entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
      addedThisPoll++;
    }

    const tNow = now();
    if (addedThisPoll > 0) {
      lastNewEntryAt = tNow;
    }

    if (tNow >= deadline) {
      stopReason = 'max_duration';
      break;
    }
    if (tNow - lastNewEntryAt >= silenceMs) {
      stopReason = 'silence';
      break;
    }

    await sleep(pollIntervalMs);
  }

  return {
    entries: collected,
    windowStart: windowStartIso,
    windowEnd: new Date(now()).toISOString(),
    truncated: false,
    stopReason,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positive(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

/**
 * Format a timestamp for `log show --start`. `log show` accepts either
 * `YYYY-MM-DD HH:MM:SS` (local time) or an ISO-ish form; the safer bet across
 * shells is a local-time string, which `log show` documents as accepted.
 */
function formatStartTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parseLogOutput(output: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    // Some simctl builds return newline-delimited entries instead of a JSON array.
    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => ({ message: line }));
  }
}

/**
 * Stable deduplication key. Prefers `timestamp + messageID + composedMessage`
 * but falls back to the raw serialisation so we never collapse distinct
 * entries.
 */
function entryKey(entry: Record<string, unknown>): string {
  const timestamp = (entry.timestamp as string) ?? '';
  const messageID = (entry.traceID ?? entry.messageID ?? '') as string | number;
  const composed = (entry.composedMessage as string) ?? (entry.message as string) ?? '';
  if (timestamp || composed) {
    return `${timestamp}|${messageID}|${composed}`;
  }
  return JSON.stringify(entry);
}
