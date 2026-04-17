import { EventEmitter } from 'events';
import { DEFAULT_MEMORY_WARN_MB, DEFAULT_MEMORY_KILL_MB, DEFAULT_RESOURCE_CHECK_INTERVAL_MS } from '../config/defaults';
import { execWithTimeout } from '../lib/exec-with-timeout';

export class SimulatorMonitor extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private warnMB: number;
  private killMB: number;
  private checkIntervalMs: number;

  constructor(options?: { warnMB?: number; killMB?: number; intervalMs?: number }) {
    super();
    this.warnMB = options?.warnMB ?? DEFAULT_MEMORY_WARN_MB;
    this.killMB = options?.killMB ?? DEFAULT_MEMORY_KILL_MB;
    this.checkIntervalMs = options?.intervalMs ?? DEFAULT_RESOURCE_CHECK_INTERVAL_MS;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    try {
      const { stdout } = await execWithTimeout('pgrep', ['-f', 'SimulatorTrampoline']);
      const pids = stdout.trim().split('\n').filter(Boolean);

      for (const pid of pids) {
        try {
          const { stdout: rssStr } = await execWithTimeout('ps', ['-o', 'rss=', '-p', pid]);
          const rssMB = Math.floor(parseInt(rssStr.trim(), 10) / 1024);

          if (rssMB > this.killMB) {
            this.emit('critical', { pid, rssMB, threshold: this.killMB });
          } else if (rssMB > this.warnMB) {
            this.emit('warn', { pid, rssMB, threshold: this.warnMB });
          }
        } catch {
          // Process may have exited
        }
      }
    } catch {
      // No SimulatorTrampoline processes running
    }
  }
}
