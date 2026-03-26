import { spawn, ChildProcess } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';

const execFileAsync = promisify(execFile);

export interface ProxyOptions {
  port?: number;
  deviceListPort?: number;
}

export class WebInspectorProxy {
  private process: ChildProcess | null = null;
  private port: number;
  private deviceListPort: number;

  constructor(options?: ProxyOptions) {
    this.port = options?.port ?? 9222;
    this.deviceListPort = options?.deviceListPort ?? 9221;
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

    const portInUse = await this.isPortInUse(this.port);
    if (portInUse) {
      console.error(`[WebInspectorProxy] Port ${this.port} already in use — skipping proxy start`);
      return;
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

    this.process.on('exit', () => { this.process = null; });
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      await new Promise(r => setTimeout(r, 500));
    }
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
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => { server.close(); resolve(false); });
      server.listen(port);
    });
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
}
