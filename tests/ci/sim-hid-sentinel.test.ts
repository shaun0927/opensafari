/**
 * SimulatorKit HID Sentinel Tests (issue #493).
 *
 * Lightweight smoke tests that verify the private framework dependencies
 * used by sim-hid-bridge are still present on the current macOS + Xcode.
 *
 * Intended to run as a daily CI cron job so BC-breaks from Apple are
 * detected early. NOT included in the default `npm test` run — gated
 * via jest.config.js testPathIgnorePatterns or run explicitly:
 *
 *   npx jest tests/ci/sim-hid-sentinel.test.ts
 *
 * These tests do NOT inject real HID events — they only probe framework
 * loading and symbol availability.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const BRIDGE_TIMEOUT_MS = 30_000;

type BridgeResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

type DiagReport = {
  ok?: boolean;
  simulatorKit?: { loaded?: boolean; path?: string | null };
  coreSimulator?: { loaded?: boolean; path?: string | null };
  classes?: Record<string, boolean>;
  indigoSymbols?: Record<string, boolean>;
};

/** Locate the sim-hid-bridge binary or .swift source. */
function findBridge(): string | null {
  const candidates = [
    // Prefer the native Swift binary emitted by `npm run build`: the
    // interpreter path can spend the whole first-probe budget compiling on
    // macos-15 before it even reaches the private-framework checks. The
    // sentinel assertions below already tolerate the historical generic
    // fake-UDID exit code while preserving hard failures for exit 78 private
    // API break responses.
    path.resolve(__dirname, '..', '..', 'dist', 'sim-hid-bridge-native'),
    path.resolve(__dirname, '..', '..', 'dist', 'sim-hid-bridge'),
    path.resolve(__dirname, '..', '..', 'dist', 'sim-hid-bridge.swift'),
    path.resolve(__dirname, '..', '..', 'src', 'native', 'sim-hid-bridge.swift'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Run the bridge with given args and return exit code + stdout + stderr. */
async function runBridge(
  args: string[],
): Promise<BridgeResult> {
  const bridgePath = findBridge();
  if (!bridgePath) {
    return {
      exitCode: -1,
      signal: null,
      killed: false,
      timedOut: false,
      stdout: '',
      stderr: 'bridge not found',
    };
  }

  const cmd = bridgePath.endsWith('.swift') ? 'swift' : bridgePath;
  const cmdArgs = bridgePath.endsWith('.swift') ? [bridgePath, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: BRIDGE_TIMEOUT_MS,
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
    };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      signal: e.signal ?? null,
      killed: e.killed === true,
      timedOut: e.killed === true,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

let diagResult: BridgeResult;
let diagReport: DiagReport | undefined;
let diagParseError: Error | undefined;

beforeAll(async () => {
  diagResult = await runBridge(['diag']);
  try {
    diagReport = JSON.parse(diagResult.stdout) as DiagReport;
  } catch (err) {
    diagParseError = err as Error;
  }
}, BRIDGE_TIMEOUT_MS + 5_000);

function requireDiagReport(): DiagReport {
  if (diagResult.timedOut) {
    throw new Error(
      `[HARNESS_TIMEOUT] sim-hid-bridge diag exceeded ${BRIDGE_TIMEOUT_MS} ms. ` +
        `signal=${diagResult.signal ?? 'none'} stderr=${diagResult.stderr.trim()}`,
    );
  }
  if (diagResult.signal) {
    throw new Error(
      `[HARNESS_SIGNAL] sim-hid-bridge diag exited via ${diagResult.signal}. ` +
        `stderr=${diagResult.stderr.trim()}`,
    );
  }
  if (diagResult.exitCode !== 0) {
    throw new Error(
      `[HARNESS_EXIT] sim-hid-bridge diag exited ${diagResult.exitCode}. ` +
        `stdout=${diagResult.stdout.trim()} stderr=${diagResult.stderr.trim()}`,
    );
  }
  if (diagParseError || !diagReport) {
    throw new Error(
      `[HARNESS_INVALID_JSON] sim-hid-bridge diag did not return valid JSON. ` +
        `parseError=${diagParseError?.message ?? 'empty output'} ` +
        `stdout=${diagResult.stdout.trim()} stderr=${diagResult.stderr.trim()}`,
    );
  }
  return diagReport;
}

function requireFlag(value: boolean | undefined, code: string, detail: string): void {
  if (value !== true) {
    throw new Error(`[${code}] ${detail}`);
  }
}

describe('SimulatorKit HID Sentinel', () => {
  test('sim-hid-bridge binary or source exists', () => {
    const bridge = findBridge();
    expect(bridge).not.toBeNull();
  });

  test('diag completes and produces valid JSON', () => {
    const report = requireDiagReport();
    expect(report.ok).toBe(true);
  });

  test('SimulatorKit.framework and CoreSimulator.framework are loadable', () => {
    const report = requireDiagReport();
    requireFlag(
      report.simulatorKit?.loaded,
      'SIMULATORKIT_MISSING',
      `SimulatorKit.framework did not load. report=${JSON.stringify(report.simulatorKit)}`,
    );
    requireFlag(
      report.coreSimulator?.loaded,
      'CORESIMULATOR_MISSING',
      `CoreSimulator.framework did not load. report=${JSON.stringify(report.coreSimulator)}`,
    );
  });

  test('production HID client class is resolvable', () => {
    const report = requireDiagReport();
    requireFlag(
      report.classes?._TtC12SimulatorKit24SimDeviceLegacyHIDClient,
      'HID_CLIENT_MISSING',
      `SimDeviceLegacyHIDClient did not resolve. classes=${JSON.stringify(report.classes)}`,
    );
  });

  test('production Indigo HID symbols are resolvable', () => {
    const report = requireDiagReport();
    const required = [
      'IndigoHIDMessageForMouseNSEvent',
      'IndigoHIDMessageForKeyboardArbitrary',
      'IndigoHIDMessageForButton',
    ];
    const missing = required.filter((name) => report.indigoSymbols?.[name] !== true);
    if (missing.length > 0) {
      throw new Error(
        `[HID_SYMBOL_MISSING] Required production symbols did not resolve: ${missing.join(', ')}. ` +
          `indigoSymbols=${JSON.stringify(report.indigoSymbols)}`,
      );
    }
  });

  test('bad arguments produce exit 64', async () => {
    const result = await runBridge([]);
    expect(result.exitCode).toBe(64);
  }, BRIDGE_TIMEOUT_MS + 5_000);
});

describe('SimulatorKit HID Sentinel — PointerService probe (#590 Phase 1)', () => {
  test('PointerService symbols resolve via the cached diag report', () => {
    const report = requireDiagReport();
    const required = [
      'IndigoHIDMessageToCreatePointerService',
      'IndigoHIDMessageToRemovePointerService',
    ];
    const missing = required.filter((name) => report.indigoSymbols?.[name] !== true);
    if (missing.length > 0) {
      throw new Error(
        `[POINTER_SYMBOL_MISSING] PointerService symbols did not resolve: ${missing.join(', ')}. ` +
          `indigoSymbols=${JSON.stringify(report.indigoSymbols)}`,
      );
    }
  });
});
