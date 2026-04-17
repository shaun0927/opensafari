/**
 * Private API Regression Sentinel (issue #503).
 *
 * Probes the eight private-API surfaces that opensafari depends on:
 *   1. SimulatorKit.framework          — dlopen path exists
 *   2. CoreSimulator.framework         — dlopen path exists
 *   3. sim-hid-bridge                   — loads frameworks + resolves HID symbols
 *   4. ax-bridge (AXUIElement)          — dumps non-empty JSON from a booted simulator
 *   5. webinspectord_sim socket         — findSocketPath() returns a live path
 *   6. ios_webkit_debug_proxy binary    — is on PATH
 *   7. ax-bridge GUI-less invariant     — resolves AX root via
 *                                          AXUIElementCreateApplication(pid) and
 *                                          does not require Simulator.app foreground (#573)
 *   8. app_alert_handle (#589)          — ko-KR 3-button permission sheet resolves via
 *                                          AX label match
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
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

import { findSocketPath } from '../../src/simulator/socket-finder';
import { MCPServer } from '../../src/mcp-server';
import { registerAppAlertHandleTool } from '../../src/tools/app-alert-handle';

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

  // Probe 8 verifies that app_alert_handle's AX label-match path resolves a
  // live ko-KR 3-button permission dialog end-to-end. Skips when no simulator
  // is booted, when Simulator.app is not running, or when the active locale is
  // not ko. Refs #589.
  describe('8. app_alert_handle ko-KR label-match probe (#589)', () => {
    test('resolves a ko-KR 3-button permission dialog via AX label match', async () => {
      // ── Guard 1: booted simulator ──
      const udid = await getBootedUdid();
      if (!udid) {
        console.warn(
          '[sentinel] No booted simulator found — skipping ko-KR app_alert_handle probe.',
        );
        return;
      }

      // ── Guard 2: Simulator.app must be running ──
      try {
        const { stdout: pgrep } = await execFileAsync('pgrep', ['-x', 'Simulator']);
        if (!pgrep.trim()) {
          console.warn(
            '[sentinel] Simulator.app process not found — skipping ko-KR app_alert_handle probe.',
          );
          return;
        }
      } catch {
        console.warn(
          '[sentinel] Simulator.app is not running — skipping ko-KR app_alert_handle probe.',
        );
        return;
      }

      // ── Guard 3: active locale must be ko ──
      let locale = '';
      try {
        const { stdout } = await execFileAsync('xcrun', [
          'simctl', 'spawn', udid, 'defaults', 'read', '-g', 'AppleLocale',
        ]);
        locale = stdout.trim();
      } catch {
        console.warn(
          '[sentinel] Could not read AppleLocale from simulator — skipping ko-KR app_alert_handle probe.',
        );
        return;
      }

      if (!locale.startsWith('ko')) {
        console.warn(
          `[sentinel] Simulator locale is "${locale}" (not ko) — skipping ko-KR app_alert_handle probe.`,
        );
        return;
      }

      // ── Trigger a deterministic ko-KR 3-button Maps location permission dialog ──
      try {
        await execFileAsync('xcrun', ['simctl', 'terminate', udid, 'com.apple.Maps']);
      } catch {
        // ignore — Maps may not be running
      }

      await execFileAsync('xcrun', ['simctl', 'privacy', udid, 'reset', 'location', 'com.apple.Maps']);
      await execFileAsync('xcrun', ['simctl', 'openurl', udid, 'maps://?q=Seoul']);

      await new Promise<void>((resolve) => setTimeout(resolve, 4500));

      // ── Invoke app_alert_handle via the MCP server registry ──
      const server = new MCPServer();
      registerAppAlertHandleTool(server);

      const handler = server.getToolHandler('app_alert_handle');
      if (!handler) {
        throw new Error('app_alert_handle handler not registered — internal sentinel error');
      }

      const result = await handler('sentinel', {
        buttonLabels: ['앱을 사용하는 동안 허용', 'Allow While Using App'],
        deviceId: udid,
      });

      const body = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `app_alert_handle returned non-JSON: ${body}. parseError=${(err as Error).message}`,
        );
      }

      if (parsed['error']) {
        const maybeError = parsed as { error?: unknown; code?: string };
        if (
          maybeError.code === 'SIMULATOR_NOT_RUNNING' ||
          (typeof parsed['error'] === 'string' && (parsed['error'] as string).includes('SIMULATOR_NOT_RUNNING'))
        ) {
          console.warn(
            '[sentinel] app_alert_handle reports SIMULATOR_NOT_RUNNING — skipping ko-KR probe.',
          );
          return;
        }
        throw new Error(
          `app_alert_handle returned error: ${JSON.stringify(parsed)}`,
        );
      }

      // ── Assertions ──
      expect(parsed['handled']).toBe(true);
      expect(parsed['method']).toBe('ax-press');

      const meta = parsed['_meta'] as { _telemetry?: Array<{ backend?: string }> } | undefined;
      expect(meta?._telemetry?.[0]?.backend).toBe('ax-press');

      // ── Cleanup ──
      try {
        await execFileAsync('xcrun', ['simctl', 'terminate', udid, 'com.apple.Maps']);
      } catch {
        // ignore
      }
    });
  });

  // Probe 7 enforces the ADR recorded in PR #587 on issue #573:
  // ax-bridge resolves the AX root through `AXUIElementCreateApplication(pid)`,
  // which targets Simulator.app by PID. Epic #540 requires the property that
  // AX reads do not depend on Simulator.app being the macOS frontmost app.
  // A static assertion on the Swift source guarantees the design invariant;
  // the opportunistic runtime check exercises it when the environment permits.
  describe('7. ax-bridge GUI-less invariant (#573)', () => {
    const swiftSource = path.join(REPO_ROOT, 'src', 'native', 'ax-bridge.swift');

    test('swift source resolves AX root via AXUIElementCreateApplication(pid)', async () => {
      if (!existsSync(swiftSource)) {
        throw new Error(
          `ax-bridge.swift not found at ${swiftSource} — cannot verify GUI-less invariant`,
        );
      }
      const contents = readFileSync(swiftSource, 'utf8');

      // Must construct the AX element from a PID — this is what makes the
      // bridge independent of the frontmost-application state.
      expect(contents).toMatch(/AXUIElementCreateApplication\s*\(/);

      // Must not reach for the system-wide root, which would couple reads
      // to whatever app happens to be focused.
      expect(contents).not.toMatch(/AXUIElementCreateSystemWide\s*\(/);
    });

    test('ax-bridge dump succeeds while Simulator.app is not the frontmost app', async () => {
      const bridge = findBinaryOrSource(['ax-bridge', 'ax-bridge.swift']);
      if (!bridge) throw new Error('ax-bridge not found — run npm run build first');

      const udid = await getBootedUdid();
      if (!udid) {
        console.warn(
          '[sentinel] No booted simulator — skipping ax-bridge GUI-less runtime probe.',
        );
        return;
      }

      // Query the current frontmost GUI application via osascript. If
      // Simulator.app happens to be frontmost (e.g. a developer ran the
      // probe locally with the Simulator window focused), skip rather
      // than silently passing a false positive: the runtime invariant
      // cannot be checked without a non-Simulator app on top.
      let frontmost = '';
      try {
        const { stdout } = await execFileAsync('osascript', [
          '-e',
          'tell application "System Events" to name of first application process whose frontmost is true',
        ]);
        frontmost = stdout.trim();
      } catch (err) {
        console.warn(
          `[sentinel] osascript frontmost probe failed (${(err as Error).message}); skipping runtime GUI-less probe.`,
        );
        return;
      }

      if (/^Simulator$/i.test(frontmost)) {
        console.warn(
          '[sentinel] Simulator.app is currently frontmost; cannot verify GUI-less invariant without touching UI state. Skipping runtime probe.',
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
          `ax-bridge dump produced non-JSON output while Simulator.app was not frontmost (was '${frontmost}'). ` +
            `parseError=${(err as Error).message} stdout=${body} stderr=${result.stderr.trim()}`,
        );
      }

      const maybeError = parsed as { error?: unknown; code?: string };
      if (maybeError && typeof maybeError === 'object' && 'error' in maybeError) {
        if (maybeError.code === 'SIMULATOR_NOT_RUNNING') {
          console.warn(
            '[sentinel] ax-bridge reports SIMULATOR_NOT_RUNNING — Simulator.app is not launched in this environment. Skipping runtime GUI-less probe.',
          );
          return;
        }
        throw new Error(
          `ax-bridge returned error shape while Simulator.app was not frontmost (was '${frontmost}'): ` +
            `code=${maybeError.code ?? 'unknown'} error=${String(maybeError.error)}. ` +
            'The GUI-less invariant recorded in the #573 ADR has regressed.',
        );
      }
    });
  });
});
