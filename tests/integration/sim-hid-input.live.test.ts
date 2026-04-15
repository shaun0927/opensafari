/**
 * Live integration suite for issue #491 — SimulatorKitHIDInputBackend.
 *
 * Exercises `SimulatorKitHIDInputBackend` (Tier 1) against a real booted iOS
 * Simulator. Unlike the Flutter / AppleScript suites this file intentionally
 * does NOT set `OPENSAFARI_ALLOW_FOCUS_INPUT` — the whole point of the
 * SimulatorKit bridge is that it works headlessly without the focus-stealing
 * CGEvent fallback.
 *
 * Setup prerequisites:
 *   - macOS host with Xcode 16+ installed (SimulatorKit.framework must be
 *     reachable through the xcode-select path)
 *   - A booted iOS Simulator device. Default UDID is iPhone 16 running
 *     iOS 26.4 on this workstation; override with `OSF_DEVICE_ID=<uuid>`
 *   - `dist/sim-hid-bridge` must be present (built by `npm run build`)
 *
 * Run:
 *   OSF_DEVICE_ID=<uuid> npx jest \
 *     tests/integration/sim-hid-input.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 *
 * Localisation: the target workstation runs Settings.app in Korean so every
 * Settings query uses the Korean label. Override via the `SETTINGS_GENERAL`,
 * `SETTINGS_ABOUT` and related env vars if the host uses a different locale.
 *
 * NOTE: the SimulatorKit mouse-event path used by the current Swift bridge
 * (`IndigoHIDMessageForMouseNSEvent`) delivers events correctly for hardware
 * buttons and keyboard input, but mouse taps on iOS 26 are not consumed by
 * the UIKit responder chain — the simulator forwards them to the system
 * gesture recogniser which interprets them as a Home swipe. Scenarios that
 * depend on tapping a UIKit element therefore still fail against this PoC.
 * The affected tests are kept `test()` (not `test.skip()`) so regressions and
 * fixes both surface automatically.
 */

import { execFile, execFileSync, execSync } from 'child_process';
import { existsSync, symlinkSync, unlinkSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import {
  getInputBackend,
  resetInputBackend,
} from '../../src/tools/native-input-backend';

const execFileAsync = promisify(execFile);

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const SETTINGS_BUNDLE = 'com.apple.Preferences';
const PHOTOS_BUNDLE = 'com.apple.mobileslideshow';
const MAPS_BUNDLE = 'com.apple.Maps';

const SETTINGS_GENERAL = process.env.SETTINGS_GENERAL ?? '일반';
const SETTINGS_ABOUT = process.env.SETTINGS_ABOUT ?? '정보';
const SETTINGS_WIFI = process.env.SETTINGS_WIFI ?? 'Wi-Fi';
const SETTINGS_DISPLAY = process.env.SETTINGS_DISPLAY ?? '디스플레이 및 밝기';
const SETTINGS_SEARCH_FIELD = process.env.SETTINGS_SEARCH ?? '검색';
const SETTINGS_RESET = process.env.SETTINGS_RESET ?? '재설정';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'sim-hid-bridge');
// `tryCreateSimulatorKitHIDBackend()` probes `<backend-module>/../sim-hid-bridge`.
// Under ts-jest the module runs from `src/tools/`, so the probe looks for
// `src/sim-hid-bridge` which does not exist in the repo. We bridge the gap
// with a test-scoped symlink to the compiled binary under `dist/`.
const PROBE_SYMLINK = path.resolve(REPO_ROOT, 'src', 'sim-hid-bridge');

jest.setTimeout(180_000);

interface BridgeResponse {
  ok: boolean;
  kind?: string;
  udid?: string;
  elapsed_ms?: number;
  error?: string;
  code?: string;
}

async function runBridge(args: string[]): Promise<BridgeResponse> {
  const { stdout } = await execFileAsync(BRIDGE_PATH, args, {
    timeout: 10_000,
  });
  return JSON.parse(stdout) as BridgeResponse;
}

async function launchApp(bundle: string): Promise<void> {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${bundle}`, { stdio: 'pipe' });
  } catch {
    /* not running — fine */
  }
  execSync(`xcrun simctl launch ${DEVICE_ID} ${bundle}`, { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1800));
}

async function relaunchSettings(): Promise<void> {
  await launchApp(SETTINGS_BUNDLE);
}

async function tap(query: {
  label?: string;
  identifier?: string;
  role?: string;
  text?: string;
  index?: number;
}): Promise<{ x: number; y: number; kind: string }> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(query, { deviceId: DEVICE_ID });
  if (result.matches.length === 0) {
    throw new Error(`element not found: ${JSON.stringify(query)}`);
  }
  const m = result.matches[query.index ?? 0];
  const x = m.frame.x + m.frame.width / 2;
  const y = m.frame.y + m.frame.height / 2;
  const backend = await getInputBackend(DEVICE_ID);
  await backend.tap(DEVICE_ID, x, y);
  return { x, y, kind: backend.kind };
}

function getMouseLocation(): { x: number; y: number } {
  // CGEventGetLocation returns the global mouse cursor position in points.
  // We call a tiny Swift one-liner so the harness stays self-contained; any
  // non-macOS host will fail the suite at this point anyway.
  const out = execFileSync(
    '/usr/bin/swift',
    [
      '-e',
      'import CoreGraphics; let e = CGEvent(source: nil)!; let p = e.location; print("\\(p.x),\\(p.y)")',
    ],
    { encoding: 'utf8' },
  ).trim();
  const [sx, sy] = out.split(',');
  return { x: Number(sx), y: Number(sy) };
}

function frontmostAppName(): string {
  try {
    return execFileSync(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

beforeAll(async () => {
  if (!existsSync(BRIDGE_PATH)) {
    throw new Error(
      `sim-hid-bridge not found at ${BRIDGE_PATH}. Run \`npm run build\` first.`,
    );
  }
  // Install the test-scoped symlink so `tryCreateSimulatorKitHIDBackend`
  // discovers the compiled binary from ts-jest.
  if (!existsSync(PROBE_SYMLINK)) {
    symlinkSync(BRIDGE_PATH, PROBE_SYMLINK);
  }
  // Start every run from a clean routing cache so backend selection is not
  // poisoned by tests that previously ran in the same Jest process.
  resetInputBackend();
  await relaunchSettings();
});

afterAll(() => {
  try {
    unlinkSync(PROBE_SYMLINK);
  } catch {
    /* already gone — fine */
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend selection — these tests prove that SimulatorKitHIDInputBackend is
// chosen as Tier 1 and that we never silently fall through to AppleScript.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — backend selection', () => {
  test('getInputBackend resolves to kind="simhid" on a booted simulator', async () => {
    resetInputBackend();
    const backend = await getInputBackend(DEVICE_ID);
    expect(backend.kind).toBe('simhid');
  });

  test('OPENSAFARI_ALLOW_FOCUS_INPUT is NOT required — simhid is selected without it', async () => {
    const originalAllow = process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    try {
      resetInputBackend();
      const backend = await getInputBackend(DEVICE_ID);
      expect(backend.kind).toBe('simhid');
    } finally {
      if (originalAllow !== undefined) {
        process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = originalAllow;
      }
    }
  });

  test('AppleScript Tier is NOT used — tap round-trips through simhid only', async () => {
    await relaunchSettings();
    const result = await tap({ label: SETTINGS_GENERAL, index: 0 });
    expect(result.kind).toBe('simhid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Headless characteristics — physical mouse cursor must not move, Simulator.app
// must not be brought forward.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — headless characteristics', () => {
  test('physical mouse cursor does not move while simhid events are dispatched', async () => {
    const before = getMouseLocation();
    await runBridge([DEVICE_ID, 'tap', '200', '500']);
    await runBridge([DEVICE_ID, 'tap', '100', '100']);
    await runBridge([DEVICE_ID, 'swipe', '100', '400', '100', '200']);
    const after = getMouseLocation();
    const dx = Math.abs(after.x - before.x);
    const dy = Math.abs(after.y - before.y);
    // eslint-disable-next-line no-console
    console.error(
      `[headless] cursor before=(${before.x},${before.y}) after=(${after.x},${after.y}) Δ=(${dx},${dy})`,
    );
    expect(dx).toBeLessThan(1);
    expect(dy).toBeLessThan(1);
  });

  test('Simulator.app is NOT brought to the foreground by simhid taps', async () => {
    await runBridge([DEVICE_ID, 'tap', '200', '500']);
    const name = frontmostAppName();
    // eslint-disable-next-line no-console
    console.error(`[headless] frontmost after simhid tap: "${name}"`);
    expect(name.toLowerCase()).not.toContain('simulator');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hardware buttons — Home / Lock / Volume — via direct bridge invocation.
// The TS wrapper does not expose a button() method yet (single-responsibility
// of InputBackend), so we drive the bridge CLI directly here. When the
// wrapper grows a `sendButton()` method these tests should be refactored to
// call it so the contract is end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — hardware buttons', () => {
  test.each(['home', 'lock', 'sound-up', 'sound-down'] as const)(
    'button %s — bridge reports ok=true',
    async (btn) => {
      const r = await runBridge([DEVICE_ID, 'button', btn]);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('button');
    },
  );

  test('key (HID usage 0x28 / Enter) — bridge reports ok=true', async () => {
    const r = await runBridge([DEVICE_ID, 'key', '40']);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('key');
  });

  test('swipe — bridge reports ok=true', async () => {
    const r = await runBridge([DEVICE_ID, 'swipe', '200', '600', '200', '300']);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('swipe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Performance budgets.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — performance', () => {
  test('single tap (bridge spawn + HID injection) completes under 600 ms', async () => {
    const start = Date.now();
    await runBridge([DEVICE_ID, 'tap', '200', '500']);
    const elapsed = Date.now() - start;
    // eslint-disable-next-line no-console
    console.error(`[perf] single simhid tap: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(600);
  });

  test('helper spawn overhead — measured from bridge response envelope', async () => {
    const r = await runBridge([DEVICE_ID, 'tap', '200', '500']);
    expect(typeof r.elapsed_ms).toBe('number');
    // eslint-disable-next-line no-console
    console.error(`[perf] bridge-reported elapsed_ms: ${r.elapsed_ms}`);
    expect(r.elapsed_ms!).toBeLessThan(1500);
  });

  test('100 sequential taps — no memory leak (RSS delta < 30 MB)', async () => {
    const gc = (global as { gc?: () => void }).gc;
    if (gc) gc();
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 100; i++) {
      await runBridge([DEVICE_ID, 'tap', '200', '500']);
    }
    if (gc) gc();
    const after = process.memoryUsage().rss;
    const deltaMb = (after - before) / 1024 / 1024;
    // eslint-disable-next-line no-console
    console.error(
      `[perf] 100 sequential taps RSS delta: ${deltaMb.toFixed(2)}MB ` +
        `(before=${(before / 1024 / 1024).toFixed(1)}MB, ` +
        `after=${(after / 1024 / 1024).toFixed(1)}MB)`,
    );
    expect(deltaMb).toBeLessThan(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings.app automation scenarios — these depend on UIKit consuming the
// synthesised mouse events as touches. On the PoC Swift bridge they exercise
// the real Settings.app but may FAIL until the bridge migrates from
// `IndigoHIDMessageForMouseNSEvent` to the digitiser / touch pathway.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — Settings.app automation', () => {
  beforeEach(async () => {
    await relaunchSettings();
  });

  test(`Settings → ${SETTINGS_GENERAL} 탭 advances the navigation stack`, async () => {
    await tap({ label: SETTINGS_GENERAL, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query(
      { label: SETTINGS_ABOUT },
      { deviceId: DEVICE_ID },
    );
    expect(r.matches.length).toBeGreaterThan(0);
  });

  test(`${SETTINGS_GENERAL} → ${SETTINGS_ABOUT} 탭 advances again`, async () => {
    await tap({ label: SETTINGS_GENERAL, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    await tap({ label: SETTINGS_ABOUT, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const bridge = getAccessibilityBridge();
    // About page carries a deterministic "이름" (Name) row on modern iOS.
    const r = await bridge.query({ label: '이름' }, { deviceId: DEVICE_ID });
    expect(r.matches.length).toBeGreaterThan(0);
  });

  test(`검색 필드 텍스트 입력 matches a Settings entry`, async () => {
    const backend = await getInputBackend(DEVICE_ID);
    await tap({ label: SETTINGS_SEARCH_FIELD });
    await new Promise((r) => setTimeout(r, 400));
    await backend.typeText(DEVICE_ID, 'wifi');
    await new Promise((r) => setTimeout(r, 800));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query(
      { label: SETTINGS_WIFI },
      { deviceId: DEVICE_ID },
    );
    expect(r.matches.length).toBeGreaterThan(0);
  });

  test(`Wi-Fi 토글 — Wi-Fi row tap advances navigation`, async () => {
    await tap({ label: SETTINGS_WIFI, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query(
      { label: SETTINGS_WIFI },
      { deviceId: DEVICE_ID },
    );
    // Wi-Fi sub-page has a Wi-Fi switch plus a page title → ≥ 2 matches.
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });

  test(`${SETTINGS_DISPLAY} → Dark Mode switches appearance`, async () => {
    await tap({ label: SETTINGS_DISPLAY, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    await tap({ label: '다크', index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query({ label: '다크' }, { deviceId: DEVICE_ID });
    expect(r.matches.length).toBeGreaterThan(0);
  });

  test(`Reset menu navigation — ${SETTINGS_GENERAL} → 이동 또는 재설정`, async () => {
    await tap({ label: SETTINGS_GENERAL, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    await tap({ label: SETTINGS_RESET, index: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query(
      { label: '모든 설정 재설정' },
      { deviceId: DEVICE_ID },
    );
    expect(r.matches.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-app compatibility — same simhid backend must drive Settings, Photos
// and Maps. Only checks the backend resolution per bundle; full UI navigation
// is covered by the Settings.app suite above.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — cross-app backend consistency', () => {
  test.each([
    ['Settings', SETTINGS_BUNDLE],
    ['Photos', PHOTOS_BUNDLE],
    ['Maps', MAPS_BUNDLE],
  ])(`%s — resolves to simhid backend`, async (_name, bundle) => {
    await launchApp(bundle);
    resetInputBackend();
    const backend = await getInputBackend(DEVICE_ID);
    expect(backend.kind).toBe('simhid');
  });
});
