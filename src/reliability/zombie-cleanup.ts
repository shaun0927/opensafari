import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
 * Runtime cleanup: shut down booted simulators not managed by our pool.
 * Uses `simctl shutdown` for safe teardown instead of raw process kills.
 */
async function cleanupOrphanedSimulators(knownDeviceIds: Set<string>): Promise<number> {
  let cleaned = 0;
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const data = JSON.parse(stdout);

    for (const runtime of Object.values(data.devices) as any[]) {
      for (const device of runtime) {
        if (device.state === 'Booted' && !knownDeviceIds.has(device.udid)) {
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

/**
 * Start periodic zombie cleanup that compares booted simulators against
 * the pool's known devices and shuts down orphans.
 */
export function startPeriodicCleanup(
  getKnownDeviceIds: () => Set<string>,
  intervalMs = 60000,
): void {
  stopPeriodicCleanup();
  cleanupInterval = setInterval(async () => {
    const ids = getKnownDeviceIds();
    const cleaned = await cleanupZombieProcesses(ids);
    if (cleaned > 0) {
      console.error(`[ZombieCleanup] Periodic cleanup removed ${cleaned} orphaned simulator(s)`);
    }
  }, intervalMs);
  cleanupInterval.unref();
}

/**
 * Stop periodic zombie cleanup.
 */
export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
