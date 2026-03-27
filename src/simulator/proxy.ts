import { spawn, ChildProcess } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
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
  private port: number;
  private deviceListPort: number;

  constructor(options?: ProxyOptions) {
    const envPort = process.env.OPENSAFARI_PROXY_PORT
      ? parseInt(process.env.OPENSAFARI_PROXY_PORT, 10)
      : undefined;
    this.port = options?.port ?? envPort ?? 9322;
    this.deviceListPort = options?.deviceListPort ?? 9321;
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

  async start(): Promise<void> {
    if (this.process) return;

    // Check if another ios_webkit_debug_proxy is already running
    const existingProxy = await this.isProxyAlreadyRunning();
    if (existingProxy) {
      throw new Error(
        `Another ios_webkit_debug_proxy process is already running. ` +
        `Stop it first (pkill ios_webkit_debug_proxy) or use a different port ` +
        `(e.g. port ${this.port + 100}) via the OPENSAFARI_PROXY_PORT env var.`
      );
    }

    const portInUse = await this.isPortInUse(this.port);
    if (portInUse) {
      throw new Error(
        `Port ${this.port} already in use. ` +
        `Use a different port (e.g. port ${this.port + 100}) via the OPENSAFARI_PROXY_PORT env var ` +
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
      '-c', `null:${this.deviceListPort},:${this.port}-${this.port + 100}`,
      '-F',
    ];

    this.process = spawn('ios_webkit_debug_proxy', args, {
      stdio: 'ignore',
      detached: false,
    });

    this.process.on('error', (err) => {
      console.error(`[WebInspectorProxy] Process error: ${err.message}`);
      this.process = null;
    });

    this.process.on('exit', () => { this.process = null; });
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        this.process = null;
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getPort(): number {
    return this.port;
  }

  private async waitForReady(timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const body = await this.httpGet(`http://localhost:${this.deviceListPort}`);
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

  /**
   * Checks whether another ios_webkit_debug_proxy process is already running.
   * This catches conflicts that port-checking alone would miss, because
   * ios_webkit_debug_proxy only binds device ports on-demand when a device connects.
   */
  private async isProxyAlreadyRunning(): Promise<boolean> {
    try {
      await execFileAsync('pgrep', ['-x', 'ios_webkit_debug_proxy']);
      // pgrep exits 0 when at least one matching process is found
      return true;
    } catch {
      // pgrep exits non-zero when no matching process is found
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
