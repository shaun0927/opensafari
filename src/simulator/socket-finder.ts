import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';

const execFileAsync = promisify(execFile);

const SOCKET_NAME = 'com.apple.webinspectord_sim.socket';
const SOCKET_SEARCH_DIRS = ['/private/var/tmp', '/private/tmp'];
const PROBE_TIMEOUT_MS = 2000;

export interface FindSocketOptions {
  /** Target a specific simulator by UDID (for multi-simulator support). */
  targetUdid?: string;
}

/**
 * Find the active WebKit Inspector socket using tiered resolution:
 *
 *  Tier 1 – `lsof -U`: definitively maps sockets to running `launchd_sim`
 *           processes. Supports `targetUdid` for multi-simulator selection.
 *  Tier 2 – mtime-sorted `fs.stat()`: collects all candidate sockets, sorts
 *           by modification time (newest first), probes each with net.connect.
 *
 * Both tiers validate candidates with a `net.connect()` liveness probe before
 * returning. Returns `null` when no live socket is found.
 */
export async function findSocketPath(options?: FindSocketOptions): Promise<string | null> {
  // Tier 1: lsof -U — definitive process-level match
  const lsofResult = await findViaLsof(options?.targetUdid);
  if (lsofResult) return lsofResult;

  // When targetUdid is specified, only lsof can map sockets to simulator UDIDs.
  // The mtime fallback cannot distinguish which simulator owns which socket,
  // so skip it to avoid returning the wrong simulator's socket.
  if (options?.targetUdid) return null;

  // Tier 2: mtime-sorted fallback with liveness probe
  return findViaMtime();
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
