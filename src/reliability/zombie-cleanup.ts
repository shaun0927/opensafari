import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function cleanupZombieProcesses(): Promise<number> {
  let cleaned = 0;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'CoreSimulator']);
    const pids = stdout.trim().split('\n').filter(Boolean);
    // Just report — don't kill blindly
    if (pids.length > 0) {
      console.error(`[ZombieCleanup] Found ${pids.length} CoreSimulator processes`);
      cleaned = pids.length;
    }
  } catch {
    // No CoreSimulator processes
  }
  return cleaned;
}
