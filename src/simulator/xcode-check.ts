import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface XcodeCheckResult {
  installed: boolean;
  version?: string;
  simulatorAvailable: boolean;
  iosRuntimes: string[];
  issues: string[];
  suggestions: string[];
}

export async function checkXcodeInstallation(): Promise<XcodeCheckResult> {
  const result: XcodeCheckResult = {
    installed: false,
    simulatorAvailable: false,
    iosRuntimes: [],
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

  return result;
}
