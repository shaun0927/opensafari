/**
 * Private API Regression Sentinel (issue #503).
 *
 * Probes the six private-API surfaces that opensafari depends on:
 *   1. SimulatorKit.framework          — dlopen path exists
 *   2. CoreSimulator.framework         — dlopen path exists
 *   3. sim-hid-bridge                   — loads frameworks + resolves HID symbols
 *   4. ax-bridge (AXUIElement)          — dumps non-empty JSON from a booted simulator
 *   5. webinspectord_sim socket         — findSocketPath() returns a live path
 *   6. ios_webkit_debug_proxy binary    — is on PATH
 *
 * Excluded from `npm test`. Designed to run daily in CI (see
 * .github/workflows/private-api-sentinel.yml) so Apple-side breakage in
 * Xcode updates is surfaced within 24 hours.
 *
 * Run locally:
 *   npm run test:sentinel
 *
 * Exit-code contract from sim-hid-bridge (src/native/sim-hid-bridge.swift):
 *    0  — success
 *   64  — usage error
 *   69  — device not found / not booted (frameworks OK)
 *   78  — framework/HID symbol failure (private API breakage)
 *
 * Tests 4 and 5 require a booted iOS simulator. They skip with a warning
 * when none is found so dev machines without a simulator do not produce
 * false-positive sentinel alerts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as path from 'path';

import { findSocketPath } from '../../src/simulator/socket-finder';

const execFileAsync = promisify(execFile);

const SIMULATORKIT_PATHS = [
  '/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit',
  '/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit',
  '/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit',
  '/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit',
];

const CORESIMULATOR_PATHS = [
  '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator',
  '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator',
  '/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator',
];

const FAKE_UDID = '00000000-0000-0000-0000-000000000000';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

type SpawnResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function findBinaryOrSource(names: string[]): string | null {
  for (const name of names) {
    const compiled = path.join(REPO_ROOT, 'dist', name);
    if (existsSync(compiled)) return compiled;
  }
  for (const name of names) {
    if (name.endsWith('.swift')) {
      const src = path.join(REPO_ROOT, 'src', 'native', name);
      if (existsSync(src)) return src;
    }
  }
  return null;
}

async function spawnBridge(binary: string, args: string[]): Promise<SpawnResult> {
  const useInterpreter = binary.endsWith('.swift');
  const cmd = useInterpreter ? 'swift' : binary;
  const cmdArgs = useInterpreter ? [binary, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { timeout: 30_000 });
    return { exitCode: 0, signal: null, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      signal: e.signal ?? null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

async function getBootedUdid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const list of Object.values(parsed.devices)) {
      for (const device of list) {
        if (device.state === 'Booted') return device.udid;
      }
    }
  } catch {
    // simctl unavailable — caller handles
  }
  return null;
}

describe('Private API Sentinel', () => {
  describe('1. SimulatorKit.framework dlopen probe', () => {
    test('at least one framework path exists on disk', () => {
      const found = SIMULATORKIT_PATHS.find(p => existsSync(p));
      if (!found) {
        throw new Error(
          'SimulatorKit.framework not found at any known path. ' +
            'Apple may have moved or removed it. Searched:\n' +
            SIMULATORKIT_PATHS.map(p => `  - ${p}`).join('\n'),
        );
      }
      expect(found).toBeTruthy();
    });
  });

  describe('2. CoreSimulator.framework dlopen probe', () => {
    test('at least one framework path exists on disk', () => {
      const found = CORESIMULATOR_PATHS.find(p => existsSync(p));
      if (!found) {
        throw new Error(
          'CoreSimulator.framework not found at any known path. ' +
            'Apple may have moved or removed it. Searched:\n' +
            CORESIMULATOR_PATHS.map(p => `  - ${p}`).join('\n'),
        );
      }
      expect(found).toBeTruthy();
    });
  });

  describe('3. sim-hid-bridge spawn probe', () => {
    const bridge = findBinaryOrSource(['sim-hid-bridge', 'sim-hid-bridge.swift']);

    test('binary or swift source is present', () => {
      expect(bridge).not.toBeNull();
    });

    test('spawn exits without crash signal and with a non-framework-failure exit code', async () => {
      if (!bridge) throw new Error('sim-hid-bridge not found — run npm run build first');

      const result = await spawnBridge(bridge, [FAKE_UDID, 'tap', '0', '0']);

      expect(result.signal).not.toBe('SIGABRT');
      expect(result.signal).not.toBe('SIGSEGV');
      expect(result.signal).not.toBe('SIGBUS');

      let parsed: { code?: string } = {};
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        // Non-JSON stdout — caught by assertions below
      }

      if (result.exitCode === 78) {
        const apiFailureCodes = [
          'SIMULATORKIT_MISSING',
          'CORESIMULATOR_MISSING',
          'HID_CLIENT_FAILED',
          'HID_FUNCTIONS_MISSING',
        ];
        if (parsed.code && apiFailureCodes.includes(parsed.code)) {
          throw new Error(
            `sim-hid-bridge reported private-API failure (code=${parsed.code}). ` +
              'Apple may have changed SimulatorKit/CoreSimulator. ' +
              `stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
          );
        }
      }

      // Exit codes proving frameworks + HID symbols resolved successfully:
      //   69 — device not found (expected for FAKE_UDID)
      //   99 — PoC stub path (frameworks loaded, HID injection stubbed)
      expect([69, 99]).toContain(result.exitCode);
    });
  });

  describe('4. ax-bridge AXUIElement probe', () => {
    const bridge = findBinaryOrSource(['ax-bridge', 'ax-bridge.swift']);

    test('binary or swift source is present', () => {
      expect(bridge).not.toBeNull();
    });

    test('dump returns non-empty JSON from a booted simulator', async () => {
      if (!bridge) throw new Error('ax-bridge not found — run npm run build first');

      const udid = await getBootedUdid();
      if (!udid) {
        console.warn(
          '[sentinel] No booted simulator found — skipping ax-bridge probe. ' +
            'Boot a simulator (xcrun simctl boot ...) to run this probe.',
        );
        return;
      }

      const result = await spawnBridge(bridge, ['dump', '--device', udid, '--max-depth', '2']);

      expect(result.signal).not.toBe('SIGABRT');
      expect(result.signal).not.toBe('SIGSEGV');

      const body = result.stdout.trim();
      expect(body.length).toBeGreaterThan(0);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(
          `ax-bridge dump produced non-JSON output. AXUIElement API may have changed. ` +
            `parseError=${(err as Error).message} stdout=${body} stderr=${result.stderr.trim()}`,
        );
      }

      // AX tree returns either an object (single node) or an array of children.
      // An error shape means ax-bridge failed. SIMULATOR_NOT_RUNNING is an
      // environment gap (simctl reports booted but Simulator.app isn't
      // launched — common on GitHub Actions macOS runners) rather than an
      // Apple-side API break, so skip like we do for a missing UDID.
      const maybeError = parsed as { error?: unknown; code?: string };
      if (maybeError && typeof maybeError === 'object' && 'error' in maybeError) {
        if (maybeError.code === 'SIMULATOR_NOT_RUNNING') {
          console.warn(
            '[sentinel] ax-bridge reports SIMULATOR_NOT_RUNNING — Simulator.app is not launched in this environment. Skipping ax-bridge probe.',
          );
          return;
        }
        throw new Error(
          `ax-bridge returned error shape: code=${maybeError.code ?? 'unknown'} error=${String(maybeError.error)}`,
        );
      }
    });
  });

  describe('5. webinspectord_sim socket probe', () => {
    test('findSocketPath() returns a live socket for a booted simulator', async () => {
      const udid = await getBootedUdid();
      if (!udid) {
        console.warn(
          '[sentinel] No booted simulator found — skipping webinspectord_sim probe.',
        );
        return;
      }

      const socket = await findSocketPath();
      if (!socket) {
        throw new Error(
          'findSocketPath() returned null while a simulator is booted. ' +
            'com.apple.webinspectord_sim.socket layout may have changed, or launchd_sim is not advertising it.',
        );
      }
      expect(socket).toMatch(/com\.apple\.webinspectord_sim\.socket$/);
    });
  });

  describe('6. ios_webkit_debug_proxy binary probe', () => {
    test('ios_webkit_debug_proxy is resolvable on PATH', async () => {
      try {
        const { stdout } = await execFileAsync('which', ['ios_webkit_debug_proxy']);
        expect(stdout.trim().length).toBeGreaterThan(0);
      } catch {
        throw new Error(
          'ios_webkit_debug_proxy not found on PATH. ' +
            'Install with: brew install ios-webkit-debug-proxy',
        );
      }
    });
  });
});
