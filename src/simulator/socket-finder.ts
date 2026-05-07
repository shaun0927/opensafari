import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';

const execFileAsync = promisify(execFile);

const SOCKET_NAME = 'com.apple.webinspectord_sim.socket';
const SOCKET_SEARCH_DIRS = ['/private/var/tmp', '/private/tmp'];
const PROBE_TIMEOUT_MS = 2000;

/**
 * TTL for cached socket path entries in milliseconds.
 * Short-lived by design: one polling interval so a newly booted simulator
 * is not missed while keeping repeated discovery within a poll cycle cheap.
 * Override via `setSocketCacheTtl()` in tests.
 */
let SOCKET_CACHE_TTL_MS = 1500;

/** Staged backoff delays (ms) for `waitForSocketPath`. Capped at the last value. */
const BACKOFF_STAGES_MS = [200, 400, 800, 1500];

/** Cache key used when no `targetUdid` is specified. */
const NO_TARGET_KEY = '__no_target__';

interface CacheEntry {
  socketPath: string;
  expiresAt: number;
}

/** Module-scoped cache keyed by UDID or NO_TARGET_KEY. */
const socketCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Public API — cache management
// ---------------------------------------------------------------------------

/**
 * Clear the socket discovery cache. Call this in `beforeEach` during tests to
 * prevent cross-test cache pollution.
 */
export function resetSocketCache(): void {
  socketCache.clear();
}

/**
 * Override the cache TTL. Intended for tests that need deterministic timing.
 * Pass `1500` to restore the default.
 */
export function setSocketCacheTtl(ms: number): void {
  SOCKET_CACHE_TTL_MS = ms;
}

export interface FindSocketOptions {
  /** Target a specific simulator by UDID (for multi-simulator support). */
  targetUdid?: string;
}

/**
 * Find the active WebKit Inspector socket using tiered resolution:
 *
 *  Cache   – returns a recently probed live socket without invoking lsof/mtime.
 *            Keyed by `udid | "__no_target__"` — UDID-specific and agnostic
 *            entries are stored in separate buckets.
 *  Tier 1  – `lsof -U`: definitively maps sockets to running `launchd_sim`
 *            processes. Supports `targetUdid` for multi-simulator selection.
 *  Tier 2  – mtime-sorted `fs.stat()`: collects all candidate sockets, sorts
 *            by modification time (newest first), probes each with net.connect.
 *
 * Both tiers validate candidates with a `net.connect()` liveness probe before
 * returning. Returns `null` when no live socket is found.
 */
export async function findSocketPath(options?: FindSocketOptions): Promise<string | null> {
  const cacheKey = options?.targetUdid ?? NO_TARGET_KEY;

  // Cache hit: return the cached path if the entry is still valid
  const cached = socketCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    // Re-probe to confirm liveness; evict on failure so stale paths are not reused
    const alive = await probeSocket(cached.socketPath);
    if (alive) return cached.socketPath;
    socketCache.delete(cacheKey);
  }

  // Tier 1: lsof -U — definitive process-level match
  const lsofResult = await findViaLsof(options?.targetUdid);
  if (lsofResult) {
    socketCache.set(cacheKey, { socketPath: lsofResult, expiresAt: Date.now() + SOCKET_CACHE_TTL_MS });
    return lsofResult;
  }

  // When targetUdid is specified, only lsof can map sockets to simulator UDIDs.
  // The mtime fallback cannot distinguish which simulator owns which socket,
  // so skip it to avoid returning the wrong simulator's socket.
  if (options?.targetUdid) return null;

  // Tier 2: mtime-sorted fallback with liveness probe
  const mtimeResult = await findViaMtime();
  if (mtimeResult) {
    socketCache.set(cacheKey, { socketPath: mtimeResult, expiresAt: Date.now() + SOCKET_CACHE_TTL_MS });
  }
  return mtimeResult;
}

/**
 * Poll `findSocketPath` until a live socket is found or timeout expires.
 * Uses staged backoff (200 → 400 → 800 → 1500 ms) to reduce CPU churn while
 * still detecting newly booted simulators quickly.
 */
export async function waitForSocketPath(
  options?: FindSocketOptions & { timeout?: number; interval?: number },
): Promise<string | null> {
  const timeout = options?.timeout ?? 10_000;
  const start = Date.now();
  let stage = 0;

  while (Date.now() - start < timeout) {
    const result = await findSocketPath(options);
    if (result) return result;

    const delay = BACKOFF_STAGES_MS[Math.min(stage, BACKOFF_STAGES_MS.length - 1)];
    stage++;

    // Clamp delay so we never sleep past the overall timeout
    const remaining = timeout - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(delay, remaining)));
  }
  return null;
}

/**
 * Probe a Unix socket for liveness. Returns true if a process is listening.
 * Active sockets connect in ~1ms; stale sockets return ECONNREFUSED in ~1ms.
 */
export function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ path: socketPath });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Tier 1: lsof -U
// ---------------------------------------------------------------------------

async function findViaLsof(targetUdid?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-U'], { timeout: 5000 });
    const lines = stdout.split('\n');

    // Collect sockets owned by launchd_sim (truncated to "launchd_s" in lsof output)
    const candidates: { pid: number; socketPath: string }[] = [];
    for (const line of lines) {
      if (!line.startsWith('launchd_s') || !line.includes(SOCKET_NAME)) continue;
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1], 10);
      const socketPath = parts[parts.length - 1];
      if (socketPath && !candidates.some(c => c.socketPath === socketPath)) {
        candidates.push({ pid, socketPath });
      }
    }

    if (candidates.length === 0) return null;

    // With targetUdid, match the launchd_sim command line to the simulator UDID
    if (targetUdid) {
      for (const { pid, socketPath } of candidates) {
        try {
          const { stdout: cmdline } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args=']);
          if (cmdline.includes(targetUdid)) {
            if (await probeSocket(socketPath)) return socketPath;
          }
        } catch { continue; }
      }
      return null;
    }

    // No targetUdid: return first live socket
    for (const { socketPath } of candidates) {
      if (await probeSocket(socketPath)) return socketPath;
    }

    return null;
  } catch {
    // lsof unavailable or failed — fall through to Tier 2
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2: mtime-sorted fs.stat with liveness probe
// ---------------------------------------------------------------------------

async function findViaMtime(): Promise<string | null> {
  const candidates: { socketPath: string; mtimeMs: number }[] = [];

  for (const base of SOCKET_SEARCH_DIRS) {
    let dirs: string[];
    try { dirs = await fs.readdir(base); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.startsWith('com.apple.launchd.')) continue;
      const socketPath = path.join(base, dir, SOCKET_NAME);
      try {
        const stat = await fs.stat(socketPath);
        candidates.push({ socketPath, mtimeMs: stat.mtimeMs });
      } catch { continue; }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by mtime descending — newest first
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Probe each candidate until one is alive; collect stale paths for cleanup
  const stalePaths: string[] = [];
  for (const { socketPath } of candidates) {
    if (await probeSocket(socketPath)) {
      // Best-effort cleanup of confirmed-stale sockets (non-blocking)
      if (stalePaths.length > 0) cleanupStaleSockets(stalePaths);
      return socketPath;
    }
    stalePaths.push(socketPath);
  }

  // All sockets are stale — clean them all
  if (stalePaths.length > 0) cleanupStaleSockets(stalePaths);
  return null;
}

// ---------------------------------------------------------------------------
// Stale socket cleanup
// ---------------------------------------------------------------------------

/**
 * Remove directories containing confirmed-stale sockets. Non-fatal: failures
 * are logged but never block proxy startup. Only called after `probeSocket()`
 * has confirmed the socket is dead (ECONNREFUSED).
 */
function cleanupStaleSockets(socketPaths: string[]): void {
  for (const socketPath of socketPaths) {
    const dir = path.dirname(socketPath);
    fs.rm(dir, { recursive: true, force: true }).catch(err => {
      console.error(`[socket-finder] Failed to clean stale socket dir ${dir}: ${err.message}`);
    });
  }
  console.error(`[socket-finder] Cleaned ${socketPaths.length} stale socket(s)`);
}
