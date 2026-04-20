/**
 * Live regression for GitHub issue #4 — raw `dist/ax-bridge` exposing real
 * Flutter app semantics on current Simulator builds.
 *
 * The existing Flutter live suite (`flutter-fixture-ax.test.ts`) exercises
 * Flutter semantics via the Node `AccessibilityBridge` library path. The #4
 * checklist also requires a regression that uses the **packaged raw bridge
 * binary** directly — downstream harnesses call `node dist/ax-bridge …`
 * (or `execFile` against the bundled binary) without touching any TS
 * library, and that path must expose real app nodes, not only Simulator
 * chrome.
 *
 * This suite closes that gap:
 *   1. Spawns `node dist/ax-bridge` via `execFile` only — no library imports
 *      from `src/native/*`.
 *   2. Asserts `query --role AXTextField` surfaces the fixture's email
 *      field.
 *   3. Asserts `query --text Log` surfaces the login button by visible
 *      text.
 *   4. Confirms `dump` returns app-content nodes and is not flagged
 *      `chromeOnly: true`.
 *
 * Gated behind `OPENSAFARI_LIVE_RAW_BRIDGE=1`. Flutter SDK must be on PATH;
 * the suite installs the fixture before asserting.
 *
 * Run:
 *   OPENSAFARI_LIVE_RAW_BRIDGE=1 FIXTURE_DEVICE_ID=<udid> \
 *     npx jest tests/integration/issue-4-raw-bridge-flutter.live.test.ts \
 *     --runInBand
 */

import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AX_BRIDGE = path.resolve(REPO_ROOT, 'dist', 'ax-bridge');
const BUILD_SCRIPT = path.resolve(REPO_ROOT, 'tests', 'fixtures', 'flutter-qa-app', 'build.sh');
const BUNDLE_ID = 'com.opensafari.fixtures.flutterQaApp';

const LIVE_ENABLED = process.env.OPENSAFARI_LIVE_RAW_BRIDGE === '1';

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

if (LIVE_ENABLED && !shouldRun && !process.env.CI) {
  if (!hasFlutter) {
    console.error('[issue-4-raw-bridge] SKIP: flutter not on PATH');
  } else {
    console.error('[issue-4-raw-bridge] SKIP: no booted simulator and FIXTURE_DEVICE_ID/OSF_DEVICE_ID unset');
  }
}

interface RawBridgeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runRawBridge(args: string[]): Promise<RawBridgeResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [AX_BRIDGE, ...args], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describeLive('issue #4 — raw dist/ax-bridge exposes Flutter semantics', () => {
  let targetDeviceId: string;

  beforeAll(async () => {
    targetDeviceId = deviceId!;

    console.error(`[issue-4-raw-bridge] Building and installing fixture on ${targetDeviceId} …`);
    await execFileAsync('/bin/sh', [BUILD_SCRIPT, '--mode', 'release', '--device-id', targetDeviceId, '--install'], {
      timeout: 240_000,
    });

    // Launch the app and give Flutter semantics a moment to activate.
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

  test('query --role AXTextField surfaces a Flutter text field (not Simulator chrome)', async () => {
    const result = await runRawBridge(['query', '--device', targetDeviceId, '--role', 'AXTextField']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      total: number;
      matches: Array<{ role: string; label?: string; identifier?: string }>;
      chromeOnly?: boolean;
    };
    expect(parsed.chromeOnly).not.toBe(true);
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    expect(parsed.matches.some((m) => m.role === 'AXTextField')).toBe(true);
  });

  test('query --text "Log" matches the login button via visible text', async () => {
    const result = await runRawBridge(['query', '--device', targetDeviceId, '--text', 'Log']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      total: number;
      matches: Array<{ role: string; label?: string }>;
    };
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    expect(parsed.matches.some((m) => /login|log in|submit/i.test(m.label ?? ''))).toBe(true);
  });

  test('dump returns populated app content and is not flagged chromeOnly', async () => {
    const result = await runRawBridge(['dump', '--device', targetDeviceId, '--max-depth', '8']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      role: string;
      chromeOnly?: boolean;
      children?: unknown[];
      code?: string;
    };
    expect(parsed.code).toBeUndefined();
    expect(parsed.chromeOnly).not.toBe(true);
    expect(Array.isArray(parsed.children)).toBe(true);
    expect((parsed.children ?? []).length).toBeGreaterThan(0);
  });

  test('dump maxDepth=1 window frame still references the correct simulator window', async () => {
    // Additional positive assertion: the raw bridge must surface a real
    // Simulator window frame (non-zero dimensions) when the fixture is
    // foreground. A chrome-only regression would expose a zero-size frame
    // or the empty `AXMenuBar` stub.
    const result = await runRawBridge(['dump', '--device', targetDeviceId, '--max-depth', '1']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      role: string;
      frame?: { width?: number; height?: number };
    };
    expect(parsed.role).toBe('AXWindow');
    expect(parsed.frame?.width ?? 0).toBeGreaterThan(100);
    expect(parsed.frame?.height ?? 0).toBeGreaterThan(100);
  });
});
