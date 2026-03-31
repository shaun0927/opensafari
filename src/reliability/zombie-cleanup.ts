import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/** Path to the shared device registry used for cross-process coordination. */
const REGISTRY_PATH = '/tmp/opensafari-managed-devices.json';
const LOCK_PATH = REGISTRY_PATH + '.lock';
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5000;

function acquireLock(): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_PATH);
      fs.writeFileSync(path.join(LOCK_PATH, 'info'), JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      }));
      return true;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(LOCK_PATH, 'info'), 'utf-8'));
          if (Date.now() - info.timestamp > LOCK_STALE_MS) {
            releaseLock();
            continue;
          }
        } catch {
          releaseLock();
          continue;
        }
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) { /* spin */ }
        continue;
      }
      return false;
    }
  }
  console.error('[DeviceRegistry] Lock acquisition timed out');
  return false;
}

function releaseLock(): void {
  try {
    try { fs.unlinkSync(path.join(LOCK_PATH, 'info')); } catch { /* ignore */ }
    fs.rmdirSync(LOCK_PATH);
  } catch { /* ignore */ }
}

function withRegistryLock<T>(fn: () => T): T {
  if (!acquireLock()) {
    console.error('[DeviceRegistry] Proceeding without lock (timeout)');
    return fn();
  }
  try {
    return fn();
  } finally {
    releaseLock();
  }
}


/**
 * Shape of the shared device registry file.
 * Each key is a PID (stringified) that owns a set of simulator UDIDs.
 */
export interface DeviceRegistry {
  [pid: string]: {
    udids: string[];
    startedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Shared device registry helpers
// ---------------------------------------------------------------------------

/**
 * Register the current process's managed device UDIDs in the shared registry.
 * Safe to call multiple times; replaces the entry for the current PID.
 */
export function registerManagedDevices(udids: string[]): void {
  try {
    withRegistryLock(() => {
      const registry = readRegistry();
      registry[String(process.pid)] = {
        udids,
        startedAt: new Date().toISOString(),
      };
      writeRegistry(registry);
    });
    console.error(`[DeviceRegistry] Registered ${udids.length} device(s) for PID ${process.pid}`);
  } catch (err) {
    console.error(`[DeviceRegistry] Failed to register devices: ${err}`);
  }
}

/**
 * Add a single device UDID to the current process's registry entry.
 * Unlike registerManagedDevices() which replaces the entire list, this
 * appends without overwriting devices already registered by the same process
 * (e.g. devices managed by SimulatorPool).
 */
export function addManagedDevice(udid: string): void {
  try {
    withRegistryLock(() => {
      const registry = readRegistry();
      const entry = registry[String(process.pid)];
      if (entry) {
        if (!entry.udids.includes(udid)) {
          entry.udids.push(udid);
        }
      } else {
        registry[String(process.pid)] = {
          udids: [udid],
          startedAt: new Date().toISOString(),
        };
      }
      writeRegistry(registry);
    });
    console.error(`[DeviceRegistry] Added device ${udid} for PID ${process.pid}`);
  } catch (err) {
    console.error(`[DeviceRegistry] Failed to add device: ${err}`);
  }
}

/**
 * Remove the current process from the shared registry (e.g. on shutdown).
 */
export function unregisterManagedDevices(): void {
  try {
    withRegistryLock(() => {
      const registry = readRegistry();
      delete registry[String(process.pid)];
      writeRegistry(registry);
    });
    console.error(`[DeviceRegistry] Unregistered PID ${process.pid}`);
  } catch (err) {
    console.error(`[DeviceRegistry] Failed to unregister devices: ${err}`);
  }
}

/**
 * Return the set of all device UDIDs currently claimed by any live process.
 * Stale entries (dead PIDs) are pruned automatically.
 */
export function getAllManagedDeviceIds(): Set<string> {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const managed = new Set<string>();
    const stalePids: string[] = [];

    for (const pidStr of Object.keys(registry)) {
      const pid = Number(pidStr);
      if (isProcessAlive(pid)) {
        for (const udid of registry[pidStr].udids) {
          managed.add(udid);
        }
      } else {
        stalePids.push(pidStr);
      }
    }

    // Prune stale entries
    if (stalePids.length > 0) {
      for (const pid of stalePids) {
        delete registry[pid];
      }
      writeRegistry(registry);
      console.error(`[DeviceRegistry] Pruned ${stalePids.length} stale PID(s)`);
    }

    return managed;
  });
}

function readRegistry(): DeviceRegistry {
  try {
    const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    return JSON.parse(data) as DeviceRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: DeviceRegistry): void {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it —
    // treat it as alive. Only ESRCH ("no such process") means truly dead.
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Zombie cleanup logic
// ---------------------------------------------------------------------------

/**
 * Find and clean up orphaned simulator processes.
 * When knownDeviceIds is provided, only shuts down booted simulators
 * NOT in that set. When omitted (startup), reports orphaned CoreSimulator
 * processes without killing them (conservative first-run behavior).
 *
 * Returns the number of processes cleaned up or detected.
 */
export async function cleanupZombieProcesses(knownDeviceIds?: Set<string>): Promise<number> {
  if (knownDeviceIds) {
    return cleanupOrphanedSimulators(knownDeviceIds);
  }
  return detectOrphanedProcesses();
}

/**
 * Startup detection: report orphaned CoreSimulator processes without killing.
 */
async function detectOrphanedProcesses(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'CoreSimulator']);
    const pids = stdout.trim().split('\n').filter(Boolean);
    if (pids.length > 0) {
      console.error(`[ZombieCleanup] Found ${pids.length} CoreSimulator processes`);
    }
    return pids.length;
  } catch {
    return 0;
  }
}

/**
 * Runtime cleanup: shut down booted simulators not managed by our pool
 * AND not managed by any other live process in the shared registry.
 * Uses `simctl shutdown` for safe teardown instead of raw process kills.
 */
async function cleanupOrphanedSimulators(knownDeviceIds: Set<string>): Promise<number> {
  let cleaned = 0;
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const data = JSON.parse(stdout);

    // Merge local pool IDs with cross-process registry IDs
    const registeredIds = getAllManagedDeviceIds();
    const protectedIds = new Set([...knownDeviceIds, ...registeredIds]);

    for (const runtime of Object.values(data.devices) as any[]) {
      for (const device of runtime) {
        if (device.state === 'Booted' && !protectedIds.has(device.udid)) {
          try {
            await execFileAsync('xcrun', ['simctl', 'shutdown', device.udid]);
            cleaned++;
            console.error(`[ZombieCleanup] Shut down orphaned simulator: ${device.name} (${device.udid})`);
          } catch {
            // May already be shutting down
          }
        }
      }
    }
  } catch {
    // simctl not available or no booted devices
  }
  return cleaned;
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let cleanupGraceTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start periodic zombie cleanup that compares booted simulators against
 * the pool's known devices and shuts down orphans.
 *
 * Environment variables:
 * - `OPENSAFARI_DISABLE_ZOMBIE_CLEANUP=1` — skip periodic cleanup entirely
 * - `OPENSAFARI_CLEANUP_GRACE_MS` — delay before first run (default 60000ms)
 * - `OPENSAFARI_CLEANUP_INTERVAL_MS` — interval between runs (default 60000ms)
 */
export function startPeriodicCleanup(
  getKnownDeviceIds: () => Set<string>,
  intervalMs?: number,
  graceMs?: number,
): void {
  if (process.env.OPENSAFARI_DISABLE_ZOMBIE_CLEANUP === '1') {
    console.error('[ZombieCleanup] Periodic cleanup disabled via OPENSAFARI_DISABLE_ZOMBIE_CLEANUP');
    return;
  }

  const parsedInterval = process.env.OPENSAFARI_CLEANUP_INTERVAL_MS ? parseInt(process.env.OPENSAFARI_CLEANUP_INTERVAL_MS, 10) : NaN;
  const parsedGrace = process.env.OPENSAFARI_CLEANUP_GRACE_MS ? parseInt(process.env.OPENSAFARI_CLEANUP_GRACE_MS, 10) : NaN;
  const resolvedInterval = intervalMs ?? (Number.isNaN(parsedInterval) ? 60000 : parsedInterval);
  const resolvedGrace = graceMs ?? (Number.isNaN(parsedGrace) ? 60000 : parsedGrace);

  stopPeriodicCleanup();

  const runCleanup = async () => {
    const ids = getKnownDeviceIds();
    const cleaned = await cleanupZombieProcesses(ids);
    if (cleaned > 0) {
      console.error(`[ZombieCleanup] Periodic cleanup removed ${cleaned} orphaned simulator(s)`);
    }
  };

  // Delay the first cleanup to allow sibling sessions to register devices
  cleanupGraceTimeout = setTimeout(() => {
    cleanupGraceTimeout = null;
    // Run once immediately after grace period, then on interval
    runCleanup().catch(() => {});
    cleanupInterval = setInterval(() => {
      runCleanup().catch(() => {});
    }, resolvedInterval);
    cleanupInterval.unref();
  }, resolvedGrace);
  (cleanupGraceTimeout as any).unref?.();
}

/**
 * Stop periodic zombie cleanup.
 */
export function stopPeriodicCleanup(): void {
  if (cleanupGraceTimeout) {
    clearTimeout(cleanupGraceTimeout);
    cleanupGraceTimeout = null;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
