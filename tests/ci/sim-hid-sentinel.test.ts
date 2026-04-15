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

/** Locate the sim-hid-bridge binary or .swift source. */
function findBridge(): string | null {
  const candidates = [
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const bridgePath = findBridge();
  if (!bridgePath) {
    return { exitCode: -1, stdout: '', stderr: 'bridge not found' };
  }

  const cmd = bridgePath.endsWith('.swift') ? 'swift' : bridgePath;
  const cmdArgs = bridgePath.endsWith('.swift') ? [bridgePath, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: 15_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('SimulatorKit HID Sentinel', () => {
  const FAKE_UDID = '00000000-0000-0000-0000-000000000000';

  // First invocation of sim-hid-bridge on a CI runner includes a cold
  // dyld-cache + private framework load (~5s on macos-14/macos-latest
  // since the tap-digitizer probe added IOKit dlopen and extra symbol
  // resolution), which exceeds jest's 5s default. runBridge already
  // caps individual calls at 15s, so 30s gives comfortable headroom.
  jest.setTimeout(30_000);

  test('sim-hid-bridge binary or source exists', () => {
    const bridge = findBridge();
    expect(bridge).not.toBeNull();
  });

  test('SimulatorKit.framework is loadable (exit != 78 SIMULATORKIT_MISSING)', async () => {
    // Run with a fake UDID — we expect exit 69 (device not found)
    // if frameworks loaded OK, or exit 78 if dlopen fails.
    const result = await runBridge([FAKE_UDID, 'tap', '0', '0']);

    // Parse the JSON output
    let parsed: { code?: string } = {};
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Non-JSON output is also informative
    }

    // exit 78 with SIMULATORKIT_MISSING means the framework is gone
    if (result.exitCode === 78 && parsed.code === 'SIMULATORKIT_MISSING') {
      fail(
        'SimulatorKit.framework could not be loaded. ' +
          'Apple may have moved or removed it in this Xcode version. ' +
          'stderr: ' +
          result.stderr,
      );
    }

    // exit 78 with CORESIMULATOR_MISSING
    if (result.exitCode === 78 && parsed.code === 'CORESIMULATOR_MISSING') {
      fail(
        'CoreSimulator.framework could not be loaded. ' +
          'stderr: ' +
          result.stderr,
      );
    }

    // Any exit code other than 78 means frameworks loaded OK.
    // exit 69 (device not found) is the expected "frameworks OK, device missing" path.
    expect(result.exitCode).not.toBe(78);
  });

  test('HID client and IndigoHIDMessage functions are resolvable (exit != 78 HID_*)', async () => {
    // Use the fake UDID — frameworks load but device won't be found.
    // If frameworks + symbols are OK, we get exit 69.
    // If HID symbols are missing, we get exit 78 with HID_CLIENT_FAILED or HID_FUNCTIONS_MISSING.
    const result = await runBridge([FAKE_UDID, 'tap', '0', '0']);

    let parsed: { code?: string } = {};
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // ignore
    }

    if (
      result.exitCode === 78 &&
      (parsed.code === 'HID_CLIENT_FAILED' ||
        parsed.code === 'HID_FUNCTIONS_MISSING')
    ) {
      fail(
        `SimulatorKit HID symbols not available (${parsed.code}). ` +
          'Apple may have changed the private API. ' +
          'stderr: ' +
          result.stderr,
      );
    }

    // Expected exit codes that prove all symbols resolved successfully:
    //   69 — device not found (full implementation path)
    //   99 — PoC stub: frameworks loaded OK, HID injection not yet implemented
    // Both confirm that SimulatorKit + CoreSimulator loaded and HID symbols are present.
    expect([69, 99]).toContain(result.exitCode);
  });

  test('bridge produces valid JSON output', async () => {
    const result = await runBridge([FAKE_UDID, 'tap', '0', '0']);
    expect(result.stdout.trim()).toBeTruthy();

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('code');
  });

  test('bad arguments produce exit 64', async () => {
    const result = await runBridge([]);
    expect(result.exitCode).toBe(64);
  });
});
