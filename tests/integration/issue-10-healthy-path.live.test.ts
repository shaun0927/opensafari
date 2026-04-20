/**
 * Live regression for GitHub issue #10 — healthy in-app `tap` / `swipe`
 * must classify as `TARGET_BUNDLE_CONFIRMED` with `verified: true`.
 *
 * The #10 checklist covers three degraded classifications
 * (`SPRINGBOARD_FOREGROUND`, `TRANSITIONAL_STATE_TIMEOUT`,
 * `FOREGROUND_CONTEXT_UNAVAILABLE`), but the happy path — "dispatch
 * succeeded AND the target app stayed in a usable foreground state" — is
 * not yet live-asserted. This suite covers that gap against the
 * `flutter-qa-app` fixture.
 *
 * Gated behind `OPENSAFARI_LIVE_HEALTHY=1`. Requires Flutter SDK on PATH
 * plus a booted simulator.
 *
 * Run:
 *   OPENSAFARI_LIVE_HEALTHY=1 FIXTURE_DEVICE_ID=<udid> \
 *     npx jest tests/integration/issue-10-healthy-path.live.test.ts \
 *     --runInBand
 */

import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SIM_HID_BRIDGE = path.resolve(REPO_ROOT, 'dist', 'sim-hid-bridge');
const BUILD_SCRIPT = path.resolve(REPO_ROOT, 'tests', 'fixtures', 'flutter-qa-app', 'build.sh');
const BUNDLE_ID = 'com.opensafari.fixtures.flutterQaApp';

const LIVE_ENABLED = process.env.OPENSAFARI_LIVE_HEALTHY === '1';

function flutterOnPath(): boolean {
  const bin = process.env.FLUTTER_BIN ?? 'flutter';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveBootedDeviceId(): string | null {
  const fromEnv = process.env.FIXTURE_DEVICE_ID ?? process.env.OSF_DEVICE_ID;
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const match = out.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

const hasFlutter = flutterOnPath();
const deviceId = resolveBootedDeviceId();
const shouldRun = LIVE_ENABLED && hasFlutter && deviceId !== null;
const describeLive = shouldRun ? describe : describe.skip;

interface HIDResult {
  ok: boolean;
  kind: 'tap' | 'swipe';
  dispatch: 'ok' | string;
  verified: boolean;
  classification: string;
  contextVerified: boolean;
  expectedBundle?: string;
  expectedBundleMatched?: boolean;
  frontmost?: { bundleId?: string };
  warnings?: string[];
  error?: string;
  code?: string;
}

async function runHID(args: string[]): Promise<HIDResult> {
  const { stdout } = await execFileAsync('node', [SIM_HID_BRIDGE, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as HIDResult;
}

describeLive('issue #10 — healthy in-app tap/swipe classifications', () => {
  let targetDeviceId: string;

  beforeAll(async () => {
    targetDeviceId = deviceId!;

    console.error(`[issue-10-healthy] Building and installing fixture on ${targetDeviceId} …`);
    await execFileAsync('/bin/sh', [BUILD_SCRIPT, '--mode', 'release', '--device-id', targetDeviceId, '--install'], {
      timeout: 240_000,
    });

    execFileSync('xcrun', ['simctl', 'launch', targetDeviceId, BUNDLE_ID], { stdio: 'ignore', timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  });

  afterAll(() => {
    try {
      execFileSync('xcrun', ['simctl', 'terminate', targetDeviceId, BUNDLE_ID], { stdio: 'ignore', timeout: 10_000 });
    } catch {
      // best-effort cleanup
    }
  });

  test('tap inside foreground app → TARGET_BUNDLE_CONFIRMED + verified true', async () => {
    // Tap near the vertical center of the screen (Flutter scaffold body, not chrome).
    const result = await runHID([
      targetDeviceId,
      'tap',
      '200',
      '400',
      '--expect-bundle',
      BUNDLE_ID,
      '--settle-ms',
      '1200',
    ]);
    expect(result.ok).toBe(true);
    expect(result.dispatch).toBe('ok');
    expect(result.classification).toBe('TARGET_BUNDLE_CONFIRMED');
    expect(result.verified).toBe(true);
    expect(result.expectedBundleMatched).toBe(true);
    expect(result.frontmost?.bundleId).toBe(BUNDLE_ID);
  });

  test('swipe inside foreground app → TARGET_BUNDLE_CONFIRMED + verified true', async () => {
    const result = await runHID([
      targetDeviceId,
      'swipe',
      '200',
      '500',
      '200',
      '300',
      '--expect-bundle',
      BUNDLE_ID,
      '--settle-ms',
      '1200',
    ]);
    expect(result.ok).toBe(true);
    expect(result.dispatch).toBe('ok');
    expect(result.classification).toBe('TARGET_BUNDLE_CONFIRMED');
    expect(result.verified).toBe(true);
    expect(result.expectedBundleMatched).toBe(true);
    expect(result.frontmost?.bundleId).toBe(BUNDLE_ID);
  });

  test('short-form normal transitions do not trigger false TRANSITIONAL_STATE_TIMEOUT', async () => {
    // Minor UI transitions (e.g., a button press) should settle within the
    // default window. Re-tap to exercise the settle+inspect loop and
    // confirm we stay on the healthy classification.
    const result = await runHID([
      targetDeviceId,
      'tap',
      '200',
      '400',
      '--expect-bundle',
      BUNDLE_ID,
      '--settle-ms',
      '800',
      '--max-settle-retries',
      '1',
    ]);
    expect(result.ok).toBe(true);
    expect(result.classification).not.toBe('TRANSITIONAL_STATE_TIMEOUT');
    expect(result.classification).not.toBe('SPRINGBOARD_FOREGROUND');
  });

  test('strict --require-match + healthy foreground keeps ok:true', async () => {
    // Regression: strict mode must not flip a genuinely-healthy result to
    // ok:false. Only an expected-bundle mismatch may do that.
    const result = await runHID([
      targetDeviceId,
      'tap',
      '200',
      '400',
      '--expect-bundle',
      BUNDLE_ID,
      '--require-match',
      'true',
      '--settle-ms',
      '1000',
    ]);
    expect(result.ok).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.verified).toBe(true);
  });
});
