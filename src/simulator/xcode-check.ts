import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';

const execFileAsync = promisify(execFile);

const SOCKET_NAME = 'com.apple.webinspectord_sim.socket';
const SOCKET_SEARCH_DIRS = ['/private/var/tmp', '/private/tmp'];
const PROXY_PORTS = [9222, 9322];

export interface XcodeCheckResult {
  installed: boolean;
  version?: string;
  simulatorAvailable: boolean;
  iosRuntimes: string[];
  webInspectorSocket?: string;
  proxyReachable: boolean;
  issues: string[];
  suggestions: string[];
}

export async function checkXcodeInstallation(): Promise<XcodeCheckResult> {
  const result: XcodeCheckResult = {
    installed: false,
    simulatorAvailable: false,
    iosRuntimes: [],
    proxyReachable: false,
    issues: [],
    suggestions: [],
  };

  // Check platform
  if (process.platform !== 'darwin') {
    result.issues.push('OpenSafari requires macOS (Xcode Simulator is macOS only)');
    result.suggestions.push('Run on a Mac with Xcode installed');
    return result;
  }

  // Check xcrun
  try {
    await execFileAsync('xcrun', ['--version']);
    result.installed = true;
  } catch {
    result.issues.push('xcrun not found — Xcode or Command Line Tools not installed');
    result.suggestions.push('Install Xcode from the App Store, or run: xcode-select --install');
    return result;
  }

  // Check Xcode version
  try {
    const { stdout } = await execFileAsync('xcodebuild', ['-version']);
    const match = stdout.match(/Xcode (\d+\.\d+)/);
    if (match) {
      result.version = match[1];
    }
  } catch {
    result.issues.push('xcodebuild not available — Xcode may not be fully installed');
    result.suggestions.push('Install Xcode from the App Store');
  }

  // Check simctl
  try {
    await execFileAsync('xcrun', ['simctl', 'list', '-j']);
    result.simulatorAvailable = true;
  } catch {
    result.issues.push('Simulator runtime not available');
    result.suggestions.push('Open Xcode and install iOS Simulator components');
  }

  // Check iOS runtimes
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'runtimes', '-j']);
    const data = JSON.parse(stdout);
    const runtimes = (data.runtimes ?? []) as Array<{ isAvailable: boolean; version: string; platform: string }>;
    result.iosRuntimes = runtimes
      .filter((r) => r.isAvailable && r.platform === 'iOS')
      .map((r) => `iOS ${r.version}`);

    if (result.iosRuntimes.length === 0) {
      result.issues.push('No iOS Simulator runtimes installed');
      result.suggestions.push('Run: xcodebuild -downloadPlatform iOS');
    }
  } catch {
    result.issues.push('Could not list simulator runtimes');
  }

  // Check Node.js version
  const [major] = process.version.slice(1).split('.').map(Number);
  if (major < 18) {
    result.issues.push(`Node.js ${process.version} detected — requires >= 18`);
    result.suggestions.push('Upgrade Node.js to v18 or later');
  }

  // Check ios_webkit_debug_proxy
  try {
    await execFileAsync('which', ['ios_webkit_debug_proxy']);
  } catch {
    result.issues.push('ios_webkit_debug_proxy not found');
    result.suggestions.push('Install with: brew install ios-webkit-debug-proxy');
  }

  // Check Web Inspector socket path
  result.webInspectorSocket = await findWebInspectorSocket();
  if (result.webInspectorSocket) {
    console.error(`[doctor] Web Inspector socket found: ${result.webInspectorSocket}`);
  } else {
    result.issues.push('Web Inspector socket not found — is a simulator booted?');
  }

  // Check proxy connectivity
  result.proxyReachable = await checkProxyReachable();
  if (!result.proxyReachable) {
    result.suggestions.push('Start proxy with: ios_webkit_debug_proxy or use opensafari device_boot');
  }

  return result;
}

/**
 * Scan known directories for the WebKit Inspector simulator socket.
 * Duplicates the logic from proxy connection code to avoid circular imports.
 */
async function findWebInspectorSocket(): Promise<string | undefined> {
  for (const dir of SOCKET_SEARCH_DIRS) {
    const socketPath = path.join(dir, SOCKET_NAME);
    try {
      const stat = await fs.stat(socketPath);
      if (stat.isSocket()) {
        return socketPath;
      }
    } catch {
      // Socket does not exist in this directory — continue
    }
  }
  return undefined;
}

/**
 * Try to reach ios_webkit_debug_proxy on common ports.
 * Returns true if any port responds with the expected device listing page.
 */
function checkProxyReachable(): Promise<boolean> {
  const checks = PROXY_PORTS.map(
    (port) =>
      new Promise<boolean>((resolve) => {
        const req = http.get(`http://localhost:${port}`, { timeout: 2000 }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            resolve(body.includes('iOS Devices'));
          });
          res.on('error', () => resolve(false));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      }),
  );

  return Promise.all(checks).then((results) => results.some(Boolean));
}
