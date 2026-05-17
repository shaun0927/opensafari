/**
 * Live integration suite for GitHub issue #46 —
 * `dist/sim-hid-bridge` TRANSITIONAL_STATE_TIMEOUT classification.
 *
 * Verifies that the sim-hid-bridge wrapper correctly distinguishes a
 * long-lived spinner / loading transition from both a clean in-app
 * foreground and a truly-unknown foreground state.
 *
 * Gated behind `OPENSAFARI_LIVE_TRANSITIONAL=1` — follows the same
 * pattern as `OPENSAFARI_LIVE_SIMHID`. Skipped otherwise so `npm test`
 * and the default integration run stay green on machines without the
 * spinner fixture installed.
 *
 * Setup prerequisites:
 *   - macOS with Xcode 16+
 *   - Booted iOS Simulator (override UDID with OSF_DEVICE_ID)
 *   - Spinner fixture installed on the simulator:
 *       ./tests/fixtures/flutter_spinner/build.sh \
 *         --device-id $UDID --install
 *   - `dist/sim-hid-bridge` + `dist/ax-bridge` built (`npm run build`)
 *
 * Run:
 *   OPENSAFARI_LIVE_TRANSITIONAL=1 OSF_DEVICE_ID=<uuid> npx jest \
 *     tests/integration/sim-hid-transitional.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 */

import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const SPINNER_BUNDLE = 'com.opensafari.fixtures.flutterSpinnerQa';
const PREFS_BUNDLE = 'com.apple.Preferences';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'sim-hid-bridge');

const LIVE_ENABLED = process.env.OPENSAFARI_LIVE_TRANSITIONAL === '1';
const describeLive = LIVE_ENABLED ? describe : describe.skip;

jest.setTimeout(180_000);

// The spinner fixture renders a spinner-only phase for 8000ms after first
// build. The live test drives that window from the outside.
const SPINNER_WINDOW_MS = 8000;
const SETTLE_MS = 800;

interface BridgeContextResult {
  classification?: string;
  verified?: boolean;
  warnings?: string[];
  runningApps?: Array<{ bundleId: string; pid?: number }>;
  [key: string]: unknown;
}

async function runBridgeContext(args: string[]): Promise<BridgeContextResult> {
  const { stdout } = await execFileAsync(BRIDGE_PATH, args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function terminate(bundle: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'terminate', DEVICE_ID, bundle], {
      stdio: 'ignore',
    });
  } catch {
    // Terminate fails when the app is not running — that's fine.
  }
}

function launch(bundle: string): void {
  execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, bundle], {
    stdio: 'ignore',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeLive('sim-hid-bridge TRANSITIONAL_STATE_TIMEOUT (issue #46 live)', () => {
  beforeEach(() => {
    terminate(SPINNER_BUNDLE);
  });

  afterAll(() => {
    terminate(SPINNER_BUNDLE);
  });

  it('Test 1 — spinner phase is classified as TRANSITIONAL_STATE_TIMEOUT', async () => {
    launch(SPINNER_BUNDLE);
    // Hit the bridge early in the 8000ms spinner window so the two 800ms
    // settle passes both land inside the spinner phase.
    await sleep(500);

    const result = await runBridgeContext([
      'context',
      DEVICE_ID,
      '--expect-bundle',
      SPINNER_BUNDLE,
      '--settle-ms',
      String(SETTLE_MS),
    ]);

    expect(result.classification).toBe('TRANSITIONAL_STATE_TIMEOUT');
    expect(result.verified).toBe(false);
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes('transitional timeout'))).toBe(true);
    expect(warnings.some((w) => w.includes(SPINNER_BUNDLE))).toBe(true);
  });

  it('Test 2 — after the 8000ms window, classification is NOT TRANSITIONAL_STATE_TIMEOUT', async () => {
    launch(SPINNER_BUNDLE);
    // Wait past the spinner window plus a 1000ms buffer.
    await sleep(SPINNER_WINDOW_MS + 1000);

    const result = await runBridgeContext([
      'context',
      DEVICE_ID,
      '--expect-bundle',
      SPINNER_BUNDLE,
      '--settle-ms',
      String(SETTLE_MS),
    ]);

    expect(result.classification).not.toBe('TRANSITIONAL_STATE_TIMEOUT');
  });

  it('Test 3 — Settings.app launch does NOT false-positive as TRANSITIONAL_STATE_TIMEOUT', async () => {
    // Terminate spinner fixture first so its "empty tree + bundle running"
    // signal cannot bleed into the Settings probe.
    terminate(SPINNER_BUNDLE);
    launch(PREFS_BUNDLE);
    await sleep(1500);

    const result = await runBridgeContext([
      'context',
      DEVICE_ID,
      '--expect-bundle',
      PREFS_BUNDLE,
      '--settle-ms',
      String(SETTLE_MS),
    ]);

    expect(result.classification).not.toBe('TRANSITIONAL_STATE_TIMEOUT');
  });

  it('Test 4 — --max-settle-retries 0 opts out and returns first-probe verbatim (no promotion)', async () => {
    launch(SPINNER_BUNDLE);
    await sleep(500);

    const result = await runBridgeContext([
      'context',
      DEVICE_ID,
      '--expect-bundle',
      SPINNER_BUNDLE,
      '--settle-ms',
      String(SETTLE_MS),
      '--max-settle-retries',
      '0',
    ]);

    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
  });
});
