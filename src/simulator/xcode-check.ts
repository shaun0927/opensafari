import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';

const execFileAsync = promisify(execFile);

const SOCKET_NAME = 'com.apple.webinspectord_sim.socket';
const SOCKET_SEARCH_DIRS = ['/private/var/tmp', '/private/tmp'];
// Device-list ports serve the "iOS Devices" HTML listing.
// 9321 = opensafari default, 9221 = traditional ios_webkit_debug_proxy default.
const PROXY_DEVICE_LIST_PORTS = [9321, 9221];
// Device ports serve JSON target lists when a simulator device is connected.
// 9322 = opensafari default, 9222 = traditional ios_webkit_debug_proxy default.
const PROXY_DEVICE_PORTS = [9322, 9222];

export interface XcodeCheckResult {
  installed: boolean;
  version?: string;
  simulatorAvailable: boolean;
  iosRuntimes: string[];
  webInspectorSocket?: string;
  proxyReachable: boolean;
  proxyPort?: number;
  devicePortReachable: boolean;
  devicePort?: number;
  issues: string[];
  suggestions: string[];
}

export async function checkXcodeInstallation(): Promise<XcodeCheckResult> {
  const result: XcodeCheckResult = {
    installed: false,
    simulatorAvailable: false,
    iosRuntimes: [],
    proxyReachable: false,
    devicePortReachable: false,
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
  if (!result.webInspectorSocket) {
    result.issues.push('Web Inspector socket not found — is a simulator booted?');
  }

  // Check proxy connectivity
  const proxyCheck = await checkProxyReachable();
  result.proxyReachable = proxyCheck.reachable;
  result.proxyPort = proxyCheck.port;
  if (!result.proxyReachable) {
    result.suggestions.push('Start proxy with: ios_webkit_debug_proxy or use opensafari device_boot');
  }

  // Check device port connectivity (JSON target list)
  if (result.proxyReachable) {
    const devicePortCheck = await checkDevicePortReachable();
    result.devicePortReachable = devicePortCheck.reachable;
    result.devicePort = devicePortCheck.port;
    if (!result.devicePortReachable) {
      result.suggestions.push(
        'Proxy device-list is reachable but device port is not responding. ' +
        'A simulator device may not be connected, or the device port range may be misconfigured.'
      );
    }
  }

  return result;
}

/**
 * Scan known directories for the WebKit Inspector simulator socket.
 * Duplicates the logic from proxy connection code to avoid circular imports.
 */
async function findWebInspectorSocket(): Promise<string | undefined> {
  for (const base of SOCKET_SEARCH_DIRS) {
    let dirs: string[];
    try { dirs = await fs.readdir(base); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.startsWith('com.apple.launchd.')) continue;
      const socketPath = path.join(base, dir, SOCKET_NAME);
      try {
        await fs.access(socketPath);
        return socketPath;
      } catch { continue; }
    }
  }
  return undefined;
}

/**
 * Try to reach ios_webkit_debug_proxy on known device-list and device ports.
 * Device-list ports serve an HTML page containing "iOS Devices".
 * Device ports serve JSON target lists when a device is connected.
 */
async function checkProxyReachable(): Promise<{ reachable: boolean; port?: number }> {
  for (const port of PROXY_DEVICE_LIST_PORTS) {
    const ok = await httpProbe(port, 'iOS Devices');
    if (ok) return { reachable: true, port };
  }
  return { reachable: false };
}

/**
 * Try to reach the proxy's device port. A connected device returns a JSON array
 * of WebKit debugging targets. An empty array `[]` is also valid (no open tabs).
 */
async function checkDevicePortReachable(): Promise<{ reachable: boolean; port?: number }> {
  for (const port of PROXY_DEVICE_PORTS) {
    const ok = await httpProbe(port, '[');
    if (ok) return { reachable: true, port };
  }
  return { reachable: false };
}

function httpProbe(port: number, expectedBody: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => { resolve(body.includes(expectedBody)); });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
