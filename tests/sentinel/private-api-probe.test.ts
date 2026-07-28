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

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_TIMEOUT_MS = 25_000;
const LIVE_AX_TEST_TIMEOUT_MS = 70_000;
const AX_RETRY_DELAY_MS = 1_000;
const RETRYABLE_AX_CODES = new Set([
  'SIMULATOR_NOT_RUNNING',
  'DEVICE_CONTENT_ROOT_EMPTY',
  'AX_TIMEOUT',
  'BRIDGE_EXEC_FAILED',
  'AX_ERROR',
]);

type SpawnResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
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

async function spawnBridge(
  binary: string,
  args: string[],
  timeoutMs = BRIDGE_TIMEOUT_MS,
): Promise<SpawnResult> {
  const useInterpreter = binary.endsWith('.swift');
  const cmd = useInterpreter ? 'swift' : binary;
  const cmdArgs = useInterpreter ? [binary, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return {
      exitCode: 0,
      signal: null,
      killed: false,
      timedOut: false,
      stdout,
      stderr,
    };
  } catch (err) {
    const e = err as {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      message?: string;
    };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      signal: e.signal ?? null,
      killed: e.killed === true,
      timedOut: e.killed === true,
      errorCode: typeof e.code === 'string' ? e.code : undefined,
      errorMessage: e.message,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function processDetails(result: SpawnResult): string {
  return [
    `exitCode=${result.exitCode}`,
    `signal=${result.signal ?? 'none'}`,
    `killed=${result.killed}`,
    `errorCode=${result.errorCode ?? 'none'}`,
    `errorMessage=${result.errorMessage ?? 'none'}`,
    `stdout=${result.stdout.trim() || '<empty>'}`,
    `stderr=${result.stderr.trim() || '<empty>'}`,
  ].join(' ');
}

function assertProcessCompleted(result: SpawnResult, label: string): void {
  if (result.timedOut) {
    throw new Error(
      `[HARNESS_TIMEOUT] ${label} exceeded ${BRIDGE_TIMEOUT_MS} ms. ${processDetails(result)}`,
    );
  }
  if (result.killed) {
    throw new Error(`[HARNESS_KILLED] ${label} was killed. ${processDetails(result)}`);
  }
  if (result.signal) {
    throw new Error(
      `[HARNESS_SIGNAL] ${label} exited via ${result.signal}. ${processDetails(result)}`,
    );
  }
  if (result.errorCode && result.errorCode !== '1') {
    throw new Error(
      `[HARNESS_SPAWN_FAILED] ${label} could not execute. ${processDetails(result)}`,
    );
  }
}

function parseJsonOutput(result: SpawnResult, label: string): unknown {
  assertProcessCompleted(result, label);
  const body = result.stdout.trim();
  if (!body) {
    throw new Error(`[HARNESS_EMPTY_OUTPUT] ${label} produced no stdout. ${processDetails(result)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (err) {
    throw new Error(
      `[HARNESS_INVALID_JSON] ${label} produced non-JSON stdout. ` +
        `parseError=${(err as Error).message} ${processDetails(result)}`,
    );
  }
}

function structuredErrorCode(result: SpawnResult): string | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

async function ensureSimulatorAppRunning(): Promise<boolean> {
  try {
    await execFileAsync('open', ['-g', '-j', '-a', 'Simulator'], { timeout: 10_000 });
  } catch {
    // The process may already be starting; the bounded pgrep loop below is authoritative.
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-x', 'Simulator'], { timeout: 2_000 });
      if (stdout.trim()) return true;
    } catch {
      // Keep waiting until the launch budget is exhausted.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runAxDumpWithRetry(binary: string, udid: string): Promise<SpawnResult> {
  let result = await spawnBridge(
    binary,
    ['dump', '--device', udid, '--max-depth', '2'],
  );
  const firstCode = structuredErrorCode(result);
  const shouldRetry =
    result.timedOut ||
    result.stdout.trim().length === 0 ||
    (firstCode !== undefined && RETRYABLE_AX_CODES.has(firstCode));
  if (!shouldRetry) return result;

  await new Promise<void>((resolve) => setTimeout(resolve, AX_RETRY_DELAY_MS));
  return spawnBridge(binary, ['dump', '--device', udid, '--max-depth', '2']);
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
          '[SIMULATORKIT_MISSING] SimulatorKit.framework not found at any known path. ' +
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
          '[CORESIMULATOR_MISSING] CoreSimulator.framework not found at any known path. ' +
            'Apple may have moved or removed it. Searched:\n' +
            CORESIMULATOR_PATHS.map(p => `  - ${p}`).join('\n'),
        );
      }
      expect(found).toBeTruthy();
    });
  });

  describe('3. sim-hid-bridge spawn probe', () => {
    const bridge = findBinaryOrSource([
      'sim-hid-bridge-native',
      'sim-hid-bridge',
      'sim-hid-bridge.swift',
    ]);

    test('binary or swift source is present', () => {
      expect(bridge).not.toBeNull();
    });

    test('native diag reports required frameworks, class, and production symbols', async () => {
      if (!bridge) throw new Error('sim-hid-bridge not found — run npm run build first');

      const result = await spawnBridge(bridge, ['diag']);
      const parsed = parseJsonOutput(result, 'sim-hid-bridge diag') as {
        simulatorKit?: { loaded?: boolean };
        coreSimulator?: { loaded?: boolean };
        classes?: Record<string, boolean>;
        indigoSymbols?: Record<string, boolean>;
      };

      if (parsed.simulatorKit?.loaded !== true) {
        throw new Error(
          `[SIMULATORKIT_MISSING] SimulatorKit.framework did not load. ` +
            `report=${JSON.stringify(parsed.simulatorKit)}`,
        );
      }
      if (parsed.coreSimulator?.loaded !== true) {
        throw new Error(
          `[CORESIMULATOR_MISSING] CoreSimulator.framework did not load. ` +
            `report=${JSON.stringify(parsed.coreSimulator)}`,
        );
      }
      if (parsed.classes?._TtC12SimulatorKit24SimDeviceLegacyHIDClient !== true) {
        throw new Error(
          `[HID_CLIENT_MISSING] SimDeviceLegacyHIDClient did not resolve. ` +
            `classes=${JSON.stringify(parsed.classes)}`,
        );
      }

      const requiredSymbols = [
        'IndigoHIDMessageForMouseNSEvent',
        'IndigoHIDMessageForKeyboardArbitrary',
        'IndigoHIDMessageForButton',
        'IndigoHIDMessageToCreatePointerService',
        'IndigoHIDMessageToRemovePointerService',
      ];
      const missing = requiredSymbols.filter(
        (name) => parsed.indigoSymbols?.[name] !== true,
      );
      if (missing.length > 0) {
        throw new Error(
          `[HID_SYMBOL_MISSING] Required SimulatorKit symbols did not resolve: ${missing.join(', ')}. ` +
            `indigoSymbols=${JSON.stringify(parsed.indigoSymbols)}`,
        );
      }
    }, BRIDGE_TIMEOUT_MS + 5_000);
  });

  describe('4. ax-bridge AXUIElement probe', () => {
    const bridge = findBinaryOrSource([
      'ax-bridge-native',
      'ax-bridge',
      'ax-bridge.swift',
    ]);

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

      if (!(await ensureSimulatorAppRunning())) {
        console.warn(
          '[sentinel] Simulator.app did not become ready within 10 seconds — skipping ax-bridge probe.',
        );
        return;
      }

      const result = await runAxDumpWithRetry(bridge, udid);
      const parsed = parseJsonOutput(result, 'ax-bridge dump');

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
        if (
          maybeError.code === 'AX_PERMISSION_DENIED' ||
          (maybeError.code !== undefined && RETRYABLE_AX_CODES.has(maybeError.code))
        ) {
          throw new Error(
            `[HARNESS_AX_UNAVAILABLE] ax-bridge remained unavailable after one retry. ` +
              `code=${maybeError.code} error=${String(maybeError.error)} ${processDetails(result)}`,
          );
        }
        throw new Error(
          `[AX_API_REGRESSION] ax-bridge returned an unexpected structured error after one retry: ` +
            `code=${maybeError.code ?? 'unknown'} error=${String(maybeError.error)} ` +
            processDetails(result),
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `[HARNESS_NONZERO_EXIT] ax-bridge emitted a tree but exited ${result.exitCode}. ` +
            processDetails(result),
        );
      }
    }, LIVE_AX_TEST_TIMEOUT_MS);
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
          '[WEBINSPECTORD_SOCKET_MISSING] findSocketPath() returned null while a simulator is booted. ' +
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
      if (!/AXUIElementCreateApplication\s*\(/.test(contents)) {
        throw new Error(
          '[AX_API_REGRESSION] ax-bridge no longer resolves Simulator.app through AXUIElementCreateApplication(pid).',
        );
      }

      // Must not reach for the system-wide root, which would couple reads
      // to whatever app happens to be focused.
      if (/AXUIElementCreateSystemWide\s*\(/.test(contents)) {
        throw new Error(
          '[AX_API_REGRESSION] ax-bridge now uses AXUIElementCreateSystemWide(), regressing the GUI-less invariant.',
        );
      }
    });

    test('ax-bridge dump succeeds while Simulator.app is not the frontmost app', async () => {
      const bridge = findBinaryOrSource([
        'ax-bridge-native',
        'ax-bridge',
        'ax-bridge.swift',
      ]);
      if (!bridge) throw new Error('ax-bridge not found — run npm run build first');

      const udid = await getBootedUdid();
      if (!udid) {
        console.warn(
          '[sentinel] No booted simulator — skipping ax-bridge GUI-less runtime probe.',
        );
        return;
      }

      if (!(await ensureSimulatorAppRunning())) {
        console.warn(
          '[sentinel] Simulator.app did not become ready within 10 seconds — skipping GUI-less runtime probe.',
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

      const result = await runAxDumpWithRetry(bridge, udid);
      const parsed = parseJsonOutput(
        result,
        `ax-bridge GUI-less dump while '${frontmost}' was frontmost`,
      );

      const maybeError = parsed as { error?: unknown; code?: string };
      if (maybeError && typeof maybeError === 'object' && 'error' in maybeError) {
        if (maybeError.code === 'SIMULATOR_NOT_RUNNING') {
          console.warn(
            '[sentinel] ax-bridge reports SIMULATOR_NOT_RUNNING — Simulator.app is not launched in this environment. Skipping runtime GUI-less probe.',
          );
          return;
        }
        if (
          maybeError.code === 'AX_PERMISSION_DENIED' ||
          (maybeError.code !== undefined && RETRYABLE_AX_CODES.has(maybeError.code))
        ) {
          throw new Error(
            `[HARNESS_AX_UNAVAILABLE] GUI-less ax-bridge dump remained unavailable after one retry. ` +
              `frontmost=${frontmost} code=${maybeError.code} error=${String(maybeError.error)} ` +
              processDetails(result),
          );
        }
        throw new Error(
          `[AX_API_REGRESSION] ax-bridge returned an unexpected error while Simulator.app was not frontmost (was '${frontmost}'): ` +
            `code=${maybeError.code ?? 'unknown'} error=${String(maybeError.error)}. ` +
            `The GUI-less invariant recorded in the #573 ADR has regressed. ${processDetails(result)}`,
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `[HARNESS_NONZERO_EXIT] GUI-less ax-bridge dump emitted a tree but exited ${result.exitCode}. ` +
            processDetails(result),
        );
      }
    }, LIVE_AX_TEST_TIMEOUT_MS);
  });
});
