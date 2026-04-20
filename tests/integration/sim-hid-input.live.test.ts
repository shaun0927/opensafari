/**
 * Live integration suite for issue #491 — SimulatorKitHIDInputBackend.
 *
 * Exercises the SimulatorKit HID bridge (`dist/sim-hid-bridge`) against a real
 * booted iOS Simulator. This suite is the definitive live validation for the
 * bridge's post-#537 capabilities: hardware buttons, keyboard events, swipes,
 * headless dispatch characteristics, and spawn/throughput performance.
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
 * Scope vs. #537:
 *   PR #537 disabled the Tier-1 `return cachedSimHidBackend` in
 *   `getInputBackend()` because `IndigoHIDMessageForMouseNSEvent` causes the
 *   iOS 26.4 simulator to lock instead of tapping. Hardware button
 *   (`IndigoHIDMessageForButton`) and keyboard (`IndigoHIDMessageForKeyboardArbitrary`)
 *   messages are unaffected. Accordingly:
 *     - Backend-selection tests assert the new routing: simhid is probed and
 *       cached, but `getInputBackend()` does NOT return it for tap/swipe until
 *       the upstream bridge bug is resolved.
 *     - Settings.app automation tests (which require UIKit tap consumption)
 *       are `describe.skip`ped with an inline TODO(#491) — they will be
 *       re-enabled by the PR that restores Tier-1 tap routing.
 *     - Hardware button / key / swipe / performance tests drive the bridge
 *       binary directly, independent of `getInputBackend()` routing, and stay
 *       as live assertions.
 *
 * Device-state hygiene: the `button lock` hardware-button test puts the
 * simulator to sleep. `afterAll` dispatches a `button home` and waits briefly
 * so the device is unlocked for the next jest invocation. Individual tests
 * that need Settings.app relaunch the bundle explicitly.
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
  HeadlessInputUnavailableError,
  resetInputBackend,
  tryGetFlutterVMClient,
} from '../../src/tools/native-input-backend';
import { tryCreateSimulatorKitHIDBackend } from '../../src/tools/sim-hid-input-backend';

const execFileAsync = promisify(execFile);

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const SETTINGS_BUNDLE = 'com.apple.Preferences';
const PHOTOS_BUNDLE = 'com.apple.mobileslideshow';
const MAPS_BUNDLE = 'com.apple.Maps';
// Flutter sample app installed by `tests/integration/fixtures/flutter_sample`.
// Override with `OSF_FLUTTER_BUNDLE_ID` if a different fixture is deployed.
const FLUTTER_BUNDLE = process.env.OSF_FLUTTER_BUNDLE_ID ?? 'com.example.osftest';
const SIMHID_SMOKE = process.env.OPENSAFARI_SIMHID_SMOKE === '1';

// Gate for tests previously skipped pending Tier-1 simhid tap routing restoration
// (see issues #4, #34, #47). Set `OPENSAFARI_TIER1_SIMHID_RESTORED=1` when
// running against a simulator build where simhid tap/swipe dispatch is
// reliable; otherwise these blocks stay skipped to avoid red CI.
const TIER1_SIMHID_RESTORED = process.env.OPENSAFARI_TIER1_SIMHID_RESTORED === '1';
const describeIfTier1SimhidRestored = TIER1_SIMHID_RESTORED ? describe : describe.skip;

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

/**
 * Pin the macOS mouse cursor to a fixed coordinate using
 * `CGWarpMouseCursorPosition`. This is a *displacement* call: it teleports the
 * cursor without posting a CGEvent, so any subsequent movement detected by
 * `CGEventGetLocation` can only have been caused by a real CGEvent (i.e. the
 * SimHID bridge under test, or the developer's hand). Used to isolate the
 * headless-cursor assertion from incidental mouse movement during local runs.
 */
function pinMouseCursor(x: number, y: number): void {
  execFileSync(
    '/usr/bin/swift',
    [
      '-e',
      `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${x}, y: ${y}))`,
    ],
    { encoding: 'utf8' },
  );
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
  if (!SIMHID_SMOKE) {
    await relaunchSettings();
  }
});

afterAll(() => {
  try {
    unlinkSync(PROBE_SYMLINK);
  } catch {
    /* already gone — fine */
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend selection — assert the post-#537 routing: the SimulatorKit HID
// backend is probed and cached on boot, but `getInputBackend()` does NOT
// return it for tap/swipe because `IndigoHIDMessageForMouseNSEvent` locks the
// iOS 26.4 simulator. When the bridge migrates to a UIKit-consumable touch
// pathway the first two tests flip (simhid is returned again) and the third
// test should be deleted.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — backend selection', () => {
  test('tryCreateSimulatorKitHIDBackend resolves to a simhid backend on a booted simulator', async () => {
    const backend = await tryCreateSimulatorKitHIDBackend();
    expect(backend).not.toBeNull();
    expect(backend?.kind).toBe('simhid');
  });

  test('getInputBackend does NOT return simhid for tap/swipe (post-#537 regression guard)', async () => {
    const originalAllow = process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    try {
      resetInputBackend();
      await expect(getInputBackend(DEVICE_ID)).rejects.toBeInstanceOf(
        HeadlessInputUnavailableError,
      );
    } finally {
      if (originalAllow !== undefined) {
        process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = originalAllow;
      }
    }
  });

  test('getInputBackend falls through to AppleScript with explicit OPENSAFARI_ALLOW_FOCUS_INPUT opt-in', async () => {
    const originalAllow = process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';
    try {
      resetInputBackend();
      const backend = await getInputBackend(DEVICE_ID);
      expect(backend.kind).toBe('applescript');
    } finally {
      if (originalAllow === undefined) {
        delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
      } else {
        process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = originalAllow;
      }
      resetInputBackend();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Headless characteristics — physical mouse cursor must not move, Simulator.app
// must not be brought forward.
// ─────────────────────────────────────────────────────────────────────────────
describe('SimulatorKitHIDInputBackend — headless characteristics', () => {
  test('physical mouse cursor does not move while simhid events are dispatched', async () => {
    // Pin the cursor to a fixed coordinate via CGWarpMouseCursorPosition so
    // incidental developer mouse movement during the test cannot mask or
    // simulate the failure mode this assertion is designed to catch (a CGEvent
    // posted by the bridge that drags the real cursor).
    const PIN_X = 100;
    const PIN_Y = 100;
    pinMouseCursor(PIN_X, PIN_Y);
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
  // `lock` intentionally runs last: it puts the simulator to sleep and causes
  // subsequent `xcrun simctl launch` calls to fail with code 405
  // ("Unable to lookup in current state: Shutting Down"). `afterAll` below
  // wakes the device again before the next test file can run.
  test.each(['home', 'sound-up', 'sound-down', 'lock'] as const)(
    'button %s — bridge reports ok=true',
    async (btn) => {
      const r = await runBridge([DEVICE_ID, 'button', btn]);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('button');
    },
  );

  test('key (HID usage 0x28 / Enter) — bridge reports ok=true', async () => {
    // Wake the device if the preceding `lock` test has just put it to sleep.
    await runBridge([DEVICE_ID, 'button', 'home']);
    const r = await runBridge([DEVICE_ID, 'key', '40']);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('key');
  });

  test('swipe — bridge reports ok=true', async () => {
    const r = await runBridge([DEVICE_ID, 'swipe', '200', '600', '200', '300']);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('swipe');
  });

  // Ensure the device is awake before later suites (performance, etc.) run.
  afterAll(async () => {
    try {
      await runBridge([DEVICE_ID, 'button', 'home']);
    } catch {
      /* best-effort wake — safe to ignore */
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Performance budgets.
//
// GitHub-hosted macOS runners have shown multi-second variance for the private
// bridge process even when the functional headless path is healthy. Keep the
// load-bearing routing and hardware checks in CI smoke, but reserve the tight
// latency/RSS envelopes for local or dedicated perf environments.
// ─────────────────────────────────────────────────────────────────────────────
const describePerformance = SIMHID_SMOKE ? describe.skip : describe;
describePerformance('SimulatorKitHIDInputBackend — performance', () => {
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
// Settings.app automation scenarios — gated behind OPENSAFARI_TIER1_SIMHID_RESTORED.
// Tap dispatch via `IndigoHIDMessageForMouseNSEvent` is disabled until the
// upstream bridge bug tracked in #4 / #34 is resolved (see #47 for context).
// Set the env var to '1' once Tier-1 simhid tap routing is confirmed reliable.
// ─────────────────────────────────────────────────────────────────────────────
describeIfTier1SimhidRestored('SimulatorKitHIDInputBackend — Settings.app automation', () => {
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
// Cross-app compatibility — gated behind OPENSAFARI_TIER1_SIMHID_RESTORED alongside
// the Settings.app automation block. The `backend.kind === 'simhid'` assertion
// is only valid once Tier-1 tap routing is restored (see #4, #34, #47).
// Set the env var to '1' to run these assertions against a fixed simulator build.
// ─────────────────────────────────────────────────────────────────────────────
describeIfTier1SimhidRestored('SimulatorKitHIDInputBackend — cross-app backend consistency', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Native + Flutter dual-boot routing — verifies the documented behavior of
// `getInputBackend()` when both a native iOS app and a Flutter app are running
// on the same device.
//
// Current implementation (see `getInputBackend` in
// `src/tools/native-input-backend.ts`):
//   - Tier 0 wins whenever `tryGetFlutterVMClient(deviceId)` returns a client.
//     Flutter VM detection is device-scoped, not bundle-scoped, so any
//     Flutter app booted on the simulator will route input via flutter-vm
//     regardless of which app is currently in the foreground.
//   - When no Flutter app is reachable, routing falls through to the native
//     tiers (simhid disabled by #537 → simctl on Xcode ≤16 → AppleScript
//     opt-in or `HeadlessInputUnavailableError` on Xcode 26+).
//
// Skipped by default because the suite needs `OSF_FLUTTER_BUNDLE_ID` to be
// installed on the simulator. The bundled fixture in
// `tests/integration/fixtures/flutter_sample` produces `com.example.osftest`
// — install it with `flutter install --device-id <udid>` before enabling.
// ─────────────────────────────────────────────────────────────────────────────
const FLUTTER_INSTALLED = (() => {
  try {
    const out = execFileSync(
      'xcrun',
      ['simctl', 'listapps', DEVICE_ID],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return out.includes(`"${FLUTTER_BUNDLE}"`);
  } catch {
    return false;
  }
})();

const describeIfFlutter = FLUTTER_INSTALLED ? describe : describe.skip;

describeIfFlutter(
  'SimulatorKitHIDInputBackend — native + flutter dual-boot routing',
  () => {
    /**
     * Wait for the Flutter app's Dart VM Service to come online by polling
     * `tryGetFlutterVMClient` until it returns a non-null client. Flutter
     * apps need a few seconds to publish the VM Service URL after launch.
     */
    async function waitForFlutterVM(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const client = await tryGetFlutterVMClient(DEVICE_ID);
          if (client) return;
        } catch (e) {
          lastError = e;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        `Flutter VM Service did not appear within ${timeoutMs}ms` +
          (lastError ? ` (last error: ${(lastError as Error).message})` : ''),
      );
    }

    beforeAll(async () => {
      // Cold-boot both apps so the dual-boot precondition is real, not
      // inherited from a previous suite.
      try {
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
          stdio: 'pipe',
        });
      } catch {
        /* not running — fine */
      }
      try {
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${SETTINGS_BUNDLE}`, {
          stdio: 'pipe',
        });
      } catch {
        /* not running — fine */
      }
      execSync(`xcrun simctl launch ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
        stdio: 'pipe',
      });
      execSync(`xcrun simctl launch ${DEVICE_ID} ${SETTINGS_BUNDLE}`, {
        stdio: 'pipe',
      });
      await waitForFlutterVM();
      resetInputBackend();
    });

    afterAll(() => {
      try {
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
          stdio: 'pipe',
        });
      } catch {
        /* best-effort */
      }
      resetInputBackend();
    });

    test('Tier-0 wins when Flutter app is co-resident — getInputBackend resolves to flutter-vm', async () => {
      const backend = await getInputBackend(DEVICE_ID);
      expect(backend.kind).toBe('flutter-vm');
    });

    test('tryGetFlutterVMClient returns a non-null client while both apps are booted', async () => {
      const client = await tryGetFlutterVMClient(DEVICE_ID);
      expect(client).not.toBeNull();
    });

    test('terminating the Flutter app collapses Tier-0 — routing falls through', async () => {
      execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
        stdio: 'pipe',
      });
      // VM Service teardown is asynchronous; poll until tryGetFlutterVMClient
      // returns null to avoid a stale-cache race.
      const deadline = Date.now() + 15_000;
      let cleared = false;
      while (Date.now() < deadline) {
        resetInputBackend();
        const client = await tryGetFlutterVMClient(DEVICE_ID);
        if (!client) {
          cleared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(cleared).toBe(true);

      const originalAllow = process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
      delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
      try {
        await expect(getInputBackend(DEVICE_ID)).rejects.toBeInstanceOf(
          HeadlessInputUnavailableError,
        );
      } finally {
        if (originalAllow !== undefined) {
          process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = originalAllow;
        }
      }
    });
  },
);
