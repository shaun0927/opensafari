/**
 * Live integration suite for GitHub issue #42 — raw `dist/ax-bridge`
 * regression coverage for the recursive scored content-root (#40) and
 * single-snapshot chrome-only promotion (#41) fixes.
 *
 * Exercises `node dist/ax-bridge …` directly (not through the internal
 * `AccessibilityBridge` module) so the wrapper's stdout / exit-code
 * contract is asserted against the real bundled binary downstream
 * consumers receive.
 *
 * Gated behind `OSF_LIVE=1` (the standard live-test switch; see
 * `npm run test:live`). Skipped otherwise so `npm test` and the default
 * integration run stay green on machines without Xcode / simulators.
 *
 * Setup prerequisites:
 *   - macOS with Xcode 16+
 *   - At least one booted iOS Simulator (override UDID with
 *     `OSF_LIVE_DEVICE` or `OSF_DEVICE_ID`; otherwise the first booted
 *     device discovered by `simctl list devices` is used)
 *   - `dist/ax-bridge` + `dist/ax-bridge-native` built (`npm run build`)
 *
 * Run:
 *   OSF_LIVE=1 npm run test:integration -- \
 *     tests/integration/ax-bridge-raw-regression.live.test.ts
 */

import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'ax-bridge');

const PREFS_BUNDLE = 'com.apple.Preferences';

const LIVE_ENABLED = process.env.OSF_LIVE === '1';
const describeLive = LIVE_ENABLED ? describe : describe.skip;

jest.setTimeout(60_000);

interface BridgeResult {
  stdout: string;
  stderr: string;
  status: number;
}

async function runBridge(args: string[]): Promise<BridgeResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [BRIDGE_PATH, ...args], {
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout, stderr, status: 0 };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const status = typeof execErr.code === 'number' ? execErr.code : 1;
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      status,
    };
  }
}

function firstBootedDevice(): string {
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw) as {
    devices: Record<string, Array<{ state?: string; udid?: string }>>;
  };
  for (const runtime of Object.keys(parsed.devices)) {
    for (const device of parsed.devices[runtime] ?? []) {
      if (device.state === 'Booted' && device.udid) {
        return device.udid;
      }
    }
  }
  throw new Error('No booted iOS simulator found — boot one or set OSF_LIVE_DEVICE');
}

const DEVICE_ID =
  process.env.OSF_LIVE_DEVICE ?? process.env.OSF_DEVICE_ID ?? (LIVE_ENABLED ? firstBootedDevice() : '');

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

describeLive('ax-bridge raw regression (issue #42 live)', () => {
  afterAll(() => {
    if (DEVICE_ID) terminate(PREFS_BUNDLE);
  });

  it('Scenario A — dump on a booted simulator returns a populated tree with chromeOnly=false (regression guard for #40)', async () => {
    const result = await runBridge([
      'dump',
      '--device',
      DEVICE_ID,
      '--max-depth',
      '3',
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.chromeOnly).toBe(false);
    // Content-root MUST NOT be the bare window fallback — the recursive
    // scored search from #40 has to descend into an app-semantics node.
    expect(parsed.role).not.toBe('AXWindow');
    expect(Array.isArray(parsed.children) && parsed.children.length > 0).toBe(true);
  });

  it('Scenario B — Settings.app foreground returns populated non-chrome tree (non-Flutter regression guard for #41)', async () => {
    terminate(PREFS_BUNDLE);
    launch(PREFS_BUNDLE);
    await sleep(2000);

    const result = await runBridge([
      'dump',
      '--device',
      DEVICE_ID,
      '--max-depth',
      '4',
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.chromeOnly).toBe(false);
    // No false chrome-only promotion on UIKit apps — stdout is a tree, not
    // an APP_CONTENT_NOT_EXPOSED error object.
    expect(parsed.code).toBeUndefined();
  });

  it('Scenario C — query --role AXButton on a populated simulator returns matches with chromeOnly=false', async () => {
    const result = await runBridge([
      'query',
      '--device',
      DEVICE_ID,
      '--role',
      'AXButton',
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.chromeOnly).toBe(false);
    expect(typeof parsed.total).toBe('number');
    expect(parsed.total).toBeGreaterThan(0);
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches.length).toBeGreaterThan(0);
  });

  it('Scenario D — query on a populated simulator with no role match returns total:0 chromeOnly:false, exit 0 (legitimate no-match, NOT promoted to APP_CONTENT_NOT_EXPOSED)', async () => {
    const result = await runBridge([
      'query',
      '--device',
      DEVICE_ID,
      '--identifier',
      'this-identifier-does-not-exist-in-any-tree-xyz',
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.chromeOnly).toBe(false);
    expect(parsed.total).toBe(0);
    expect(parsed.code).toBeUndefined();
  });

  it('Scenario E — unknown device id returns DEVICE_RESOLUTION_FAILED with exit 1 (error-contract regression guard)', async () => {
    const result = await runBridge([
      'dump',
      '--device',
      '00000000-0000-0000-0000-000000000000',
      '--max-depth',
      '2',
    ]);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.code).toBe('DEVICE_RESOLUTION_FAILED');
  });

  it('Scenario F — --help at top level exits 0 with usage header (raw-bridge CLI contract from #42)', async () => {
    const result = await runBridge(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ax-bridge <command>');
    expect(result.stdout).toContain('Commands:');
  });
});
