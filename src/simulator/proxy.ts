import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';

const execFileAsync = promisify(execFile);

export interface ProxyOptions {
  /**
   * WebKit Inspector proxy port for device connections.
   * Defaults to 9322 (chosen to avoid conflict with openchrome on 9222).
   * Can also be set via the OPENSAFARI_PROXY_PORT environment variable.
   */
  port?: number;
  deviceListPort?: number;
  /** Additional CLI flags for ios_webkit_debug_proxy */
  extraArgs?: string[];
}

/**
 * Manages an ios_webkit_debug_proxy process for WebKit remote debugging.
 *
 * The default device-connection port is **9322**, deliberately offset from the
 * Chrome DevTools default (9222) so OpenSafari and openchrome can coexist.
 *
 * Port resolution order:
 *  1. Explicit `port` option passed to the constructor
 *  2. `OPENSAFARI_PROXY_PORT` environment variable
 *  3. Default 9322
 */
export class WebInspectorProxy {
  private process: ChildProcess | null = null;
  private _port: number;
  private _deviceListPort: number;
  private _running = false;
  private _reusing = false;

  constructor(private options: ProxyOptions = {}) {
    const envPort = process.env.OPENSAFARI_PROXY_PORT
      ? parseInt(process.env.OPENSAFARI_PROXY_PORT, 10)
      : undefined;
    this._port = options.port ?? envPort ?? 9322;
    this._deviceListPort = options.deviceListPort ?? 9321;
  }

  async findSocketPath(): Promise<string | null> {
    const searchPaths = ['/private/var/tmp', '/private/tmp'];
    for (const base of searchPaths) {
      let dirs: string[];
      try { dirs = await fs.readdir(base); } catch { continue; }
      for (const dir of dirs) {
        if (!dir.startsWith('com.apple.launchd.')) continue;
        const socketPath = path.join(base, dir, 'com.apple.webinspectord_sim.socket');
        try {
          await fs.access(socketPath);
          return socketPath;
        } catch { continue; }
      }
    }
    return null;
  }

  /** Start the proxy process. Resolves once the proxy is ready. */
  async start(): Promise<void> {
    if (this._running) return;

    // Check if our device-list port already has a healthy proxy (from another session)
    const deviceListInUse = await this.isPortInUse(this._deviceListPort);
    if (deviceListInUse) {
      const healthy = await this.isProxyHealthy();
      if (healthy) {
        console.error(`[WebInspectorProxy] Reusing existing proxy on port ${this._deviceListPort}`);
        this._running = true;
        this._reusing = true;
        this.registerRefSync();
        return;
      }
      throw new Error(
        `Port ${this._deviceListPort} already in use by a non-proxy process. ` +
        `Use a different port (e.g. OPENSAFARI_PROXY_PORT=${this._port + 100}) ` +
        `or stop the existing process.`
      );
    }

    const portInUse = await this.isPortInUse(this._port);
    if (portInUse) {
      throw new Error(
        `Port ${this._port} already in use. ` +
        `Use a different port (e.g. OPENSAFARI_PROXY_PORT=${this._port + 100}) ` +
        `or stop the existing process.`
      );
    }

    try {
      await execFileAsync('which', ['ios_webkit_debug_proxy']);
    } catch {
      throw new Error('ios_webkit_debug_proxy not found. Install: brew install ios-webkit-debug-proxy');
    }

    const socketPath = await this.findSocketPath();
    if (!socketPath) {
      throw new Error('Web Inspector socket not found. Is a simulator booted?');
    }

    const args = [
      '-s', `unix:${socketPath}`,
      '-c', `null:${this._deviceListPort},:${this._port}-${this._port + 100}`,
      '-F',
      ...(this.options.extraArgs ?? []),
    ];

    this.process = spawn('ios_webkit_debug_proxy', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this._running = true;
    this._reusing = false;
    this.registerRefSync();

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[WebInspectorProxy] ${data.toString().trim()}`);
    });

    this.process.on('error', (err) => {
      console.error(`[WebInspectorProxy] process error: ${err.message}`);
      this._running = false;
      this.process = null;
    });

    this.process.on('exit', (code) => {
      console.error(`[WebInspectorProxy] exited with code ${code}`);
      this._running = false;
      this.process = null;
    });

    await this.waitForReady();
  }

  /** Stop the proxy process gracefully with SIGKILL fallback. */
  async stop(): Promise<void> {
    const remaining = this.unregisterRefSync();

    if (this._reusing) {
      this._running = false;
      this._reusing = false;
      return;
    }
    if (!this.process) {
      this._running = false;
      return;
    }
    // Other sessions still using this proxy — detach but don't kill
    if (remaining > 0) {
      console.error(`[WebInspectorProxy] ${remaining} other session(s) still using proxy, not killing`);
      this.process = null;
      this._running = false;
      return;
    }
    // We're the last user — kill the proxy process
    const proc = this.process;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        this.process = null;
        this._running = false;
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this._running = false;
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  /** Whether the proxy process is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** The port the proxy is configured to listen on. */
  get port(): number {
    return this._port;
  }

  /** The device list port. */
  get deviceListPort(): number {
    return this._deviceListPort;
  }

  /** The PID of the proxy process, or null if not running. */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /** Whether this instance is reusing another session's proxy. */
  get reusing(): boolean {
    return this._reusing;
  }

  private getRefFilePath(): string {
    return `/tmp/opensafari-proxy-${this._deviceListPort}.refs`;
  }

  /** Register this process as a proxy user (synchronous for exit handler compatibility). */
  private registerRefSync(): void {
    const refFile = this.getRefFilePath();
    let pids: number[] = [];
    try {
      const content = readFileSync(refFile, 'utf-8');
      pids = content.trim().split('\n').map(Number).filter(Boolean);
    } catch { /* file doesn't exist yet */ }
    // Clean stale PIDs (processes that no longer exist)
    pids = pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (!pids.includes(process.pid)) {
      pids.push(process.pid);
    }
    // NOTE: TOCTOU limitation — there is no file lock between the read above and
    // this write. Two processes starting simultaneously could overwrite each other's
    // entry. The window is very narrow and self-heals: stale-PID cleanup on the next
    // read will recover any dropped entry without lasting harm.
    writeFileSync(refFile, pids.join('\n') + '\n');
  }

  /** Unregister this process. Returns the number of remaining active references. */
  private unregisterRefSync(): number {
    const refFile = this.getRefFilePath();
    let pids: number[] = [];
    try {
      const content = readFileSync(refFile, 'utf-8');
      pids = content.trim().split('\n').map(Number).filter(Boolean);
    } catch { return 0; }
    // Remove self and clean stale PIDs
    // NOTE: Same narrow TOCTOU window as registerRefSync — no file lock between
    // read and write. Self-heals via stale-PID cleanup on subsequent reads.
    pids = pids.filter(pid => {
      if (pid === process.pid) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (pids.length > 0) {
      writeFileSync(refFile, pids.join('\n') + '\n');
    } else {
      try { unlinkSync(refFile); } catch { /* ignore */ }
    }
    return pids.length;
  }

  private async waitForReady(timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const body = await this.httpGet(`http://localhost:${this._deviceListPort}`);
        if (body.includes('iOS Devices')) return;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`WebInspectorProxy did not become ready within ${timeout}ms`);
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async isProxyHealthy(): Promise<boolean> {
    try {
      const body = await this.httpGet(`http://localhost:${this._deviceListPort}`);
      return body.includes('iOS Devices');
    } catch {
      return false;
    }
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 3000 }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton so the proxy can be shared across tool calls
// and stopped cleanly on process exit.
// ---------------------------------------------------------------------------

let _sharedProxy: WebInspectorProxy | null = null;

export function getSharedProxy(): WebInspectorProxy {
  if (!_sharedProxy) {
    _sharedProxy = new WebInspectorProxy();
  }
  return _sharedProxy;
}

// Ensure the proxy is stopped when the host process exits — only if we own it
process.on('exit', () => {
  if (_sharedProxy) {
    // Note: stop() already called unregisterRefSync() during normal shutdown.
    // Calling it again here is intentional and harmless — our PID was already
    // removed, so this is a no-op that returns the current live ref count.
    const remaining = _sharedProxy['unregisterRefSync']();
    // Only kill proxy if we own it AND no other sessions reference it
    if (!_sharedProxy.reusing && _sharedProxy.running && remaining === 0) {
      try { _sharedProxy['process']?.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
});
