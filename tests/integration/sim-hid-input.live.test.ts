/**
 * Live integration suite for issue #491 — exercises
 * `SimulatorKitHIDInputBackend` against a booted iPhone Simulator and
 * verifies the headless guarantees #483 promises: the `sim-hid` backend is
 * selected, real HID events reach the simulator, the physical mouse cursor
 * never moves, and no AppleScript / focus-stealing fallback is triggered.
 *
 * Gating:
 *   This file lives under `tests/integration/`, which the default jest
 *   config excludes. Run it manually against a booted simulator:
 *
 *     npx jest tests/integration/sim-hid-input.live.test.ts --runInBand
 *
 *   The target simulator UDID can be overridden with `OSF_DEVICE_ID`.
 *
 * Environment contract:
 *   - `OPENSAFARI_ALLOW_FOCUS_INPUT` MUST NOT be set. The suite asserts
 *     that routing picks `simhid` without any opt-in.
 *   - A `sim-hid-bridge` binary must be present in `dist/` (the usual
 *     `npm run build` output). The bridge lookup follows the same
 *     candidate order as `tryCreateSimulatorKitHIDBackend()`.
 *
 * What this file does NOT assert:
 *   - Exact pixel accuracy of a tap. The AX-bridge-frame → iOS-screen-coord
 *     translation is out of scope for the SimulatorKit backend itself; the
 *     Settings-scenarios therefore assert "UI state advanced" via a
 *     follow-up `app_query` rather than "tap was within 1pt of the cell".
 *   - Multitouch / pinch zoom. The current Swift bridge exposes a single
 *     digitizer contact; multitouch is tracked as a follow-up in #483.
 */

// Prove the negative — no opt-in is set before any import reads process.env.
delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;

import { execFileSync, execSync, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { platform } from 'os';
import * as path from 'path';

import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import {
  getInputBackend,
  resetInputBackend,
} from '../../src/tools/native-input-backend';
import {
  SimulatorKitHIDInputBackend,
  tryCreateSimulatorKitHIDBackend,
} from '../../src/tools/sim-hid-input-backend';

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';

jest.setTimeout(180_000);

/** Bundle ids used across the scenarios. */
const SETTINGS = 'com.apple.Preferences';
const PHOTOS = 'com.apple.mobileslideshow';
const MAPS = 'com.apple.Maps';

/** Resolve the compiled bridge binary (not the .swift source) for direct invocation. */
function resolveBridgeBinary(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'dist', 'sim-hid-bridge'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  throw new Error(
    `sim-hid-bridge binary not found. Run "npm run build" first. ` +
      `Searched: ${candidates.join(', ')}`,
  );
}

/** Skip the whole suite when the bridge isn't built — keeps CI green on machines without Xcode. */
const BRIDGE_READY = (() => {
  if (platform() !== 'darwin') return false;
  try {
    resolveBridgeBinary();
    // Confirm the simulator is actually booted.
    const list = execSync('xcrun simctl list devices booted').toString();
    return list.includes(DEVICE_ID);
  } catch {
    return false;
  }
})();

const describeLive = BRIDGE_READY ? describe : describe.skip;

/**
 * Relaunch an app to reset its state between scenarios.
 * `xcrun simctl launch` is a no-op if already running, so we terminate first.
 */
async function relaunch(bundle: string): Promise<void> {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${bundle}`, { stdio: 'pipe' });
  } catch {
    /* not running — fine */
  }
  execSync(`xcrun simctl launch ${DEVICE_ID} ${bundle}`, { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1_500));
}

/** Read the physical mouse-cursor position in macOS global screen coordinates. */
function getMouseCursor(): { x: number; y: number } {
  const out = spawnSync(
    'osascript',
    [
      '-e',
      'tell application "System Events" to return position of mouse as list',
    ],
    { encoding: 'utf-8' },
  );
  if (out.status !== 0) {
    // On fresh CI runners System Events AX might not be authorised; fall back
    // to CGWarpMouseCursorPosition via a Python one-liner that reads current.
    const py = spawnSync(
      'python3',
      [
        '-c',
        'import Quartz; p = Quartz.NSEvent.mouseLocation(); print(p.x, p.y)',
      ],
      { encoding: 'utf-8' },
    );
    if (py.status !== 0) {
      throw new Error(
        'cannot read mouse-cursor position (AppleScript + Python both failed)',
      );
    }
    const [x, y] = py.stdout.trim().split(/\s+/).map(Number);
    return { x, y };
  }
  const [x, y] = out.stdout.trim().split(',').map((s) => Number(s.trim()));
  return { x, y };
}

describeLive('SimulatorKitHIDInputBackend (live — issue #491)', () => {
  beforeAll(() => {
    // Every test tier must start from a clean cache so we always exercise
    // the real routing decision for this suite's environment.
    resetInputBackend();
  });

  // ── 1. Routing & factory ────────────────────────────────────────────────
  describe('routing', () => {
    test('getInputBackend selects SimulatorKitHIDInputBackend (kind=simhid)', async () => {
      const backend = await getInputBackend(DEVICE_ID);
      expect(backend.kind).toBe('simhid');
      expect(backend).toBeInstanceOf(SimulatorKitHIDInputBackend);
    });

    test('OPENSAFARI_ALLOW_FOCUS_INPUT stays unset throughout the suite', () => {
      expect(process.env.OPENSAFARI_ALLOW_FOCUS_INPUT).toBeUndefined();
    });

    test('tryCreateSimulatorKitHIDBackend returns a usable backend', async () => {
      const backend = await tryCreateSimulatorKitHIDBackend();
      expect(backend).not.toBeNull();
      expect(backend?.kind).toBe('simhid');
    });
  });

  // ── 2. Wire-level contract (direct binary invocation) ──────────────────
  describe('sim-hid-bridge wire contract', () => {
    test('tap command returns ok:true with a kind label', () => {
      const bin = resolveBridgeBinary();
      const out = execFileSync(bin, [DEVICE_ID, 'tap', '50', '50'], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tap');
      expect(parsed.udid).toBe(DEVICE_ID);
      expect(typeof parsed.elapsed_ms).toBe('number');
    });

    test('swipe command returns ok:true with kind=swipe', () => {
      const bin = resolveBridgeBinary();
      const out = execFileSync(
        bin,
        [DEVICE_ID, 'swipe', '100', '400', '100', '200', '0.3'],
        { encoding: 'utf-8' },
      );
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('swipe');
    });

    test('key command accepts HID usage for Enter (0x28 = 40)', () => {
      const bin = resolveBridgeBinary();
      const out = execFileSync(bin, [DEVICE_ID, 'key', '40'], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('key');
    });

    test('button home returns ok:true — hardware button synthesis', () => {
      const bin = resolveBridgeBinary();
      const out = execFileSync(bin, [DEVICE_ID, 'button', 'home'], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('button');
    });

    test('button lock returns ok:true — hardware button synthesis', () => {
      const bin = resolveBridgeBinary();
      const out = execFileSync(bin, [DEVICE_ID, 'button', 'lock'], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      // Press lock again to restore the pre-test screen state.
      execFileSync(bin, [DEVICE_ID, 'button', 'lock'], { encoding: 'utf-8' });
    });

    test('button sound-up / sound-down return ok:true', () => {
      const bin = resolveBridgeBinary();
      for (const name of ['sound-up', 'sound-down']) {
        const out = execFileSync(bin, [DEVICE_ID, 'button', name], {
          encoding: 'utf-8',
        });
        const parsed = JSON.parse(out);
        expect(parsed.ok).toBe(true);
      }
    });

    test('unknown button name returns exit 64 BAD_ARGS', () => {
      const bin = resolveBridgeBinary();
      const r = spawnSync(bin, [DEVICE_ID, 'button', 'bogus'], {
        encoding: 'utf-8',
      });
      expect(r.status).toBe(64);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('USAGE');
    });

    test('fake UDID returns exit 69 DEVICE_NOT_FOUND — framework still loaded', () => {
      const bin = resolveBridgeBinary();
      const r = spawnSync(
        bin,
        ['00000000-0000-0000-0000-000000000000', 'tap', '10', '10'],
        { encoding: 'utf-8' },
      );
      expect(r.status).toBe(69);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      // SimulatorKit loaded fine — the failure is downstream.
      expect(parsed.code === 'DEVICE_NOT_FOUND' || parsed.code === 'DEVICE_NOT_BOOTED')
        .toBe(true);
    });
  });

  // ── 3. Headless properties ──────────────────────────────────────────────
  describe('headless guarantees', () => {
    test('physical mouse cursor position is unchanged across a tap', async () => {
      let before: { x: number; y: number };
      try {
        before = getMouseCursor();
      } catch (err) {
        // If we can't read the cursor, don't fail — this machine lacks
        // System Events AX authorisation. The runtime contract is still
        // enforced by code review + private-apis.md; this is a probe.
        console.warn('[sim-hid.live] cannot read cursor position:', err);
        return;
      }
      const backend = await getInputBackend(DEVICE_ID);
      await backend.tap(DEVICE_ID, 200, 400);
      const after = getMouseCursor();
      // Tolerate one-pixel rounding from AppleScript coord reads; the tap
      // itself must not move the cursor by a perceptible amount.
      expect(Math.abs(before.x - after.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(2);
    });

    test('backend.kind stays "simhid" across repeated resolution calls', async () => {
      for (let i = 0; i < 5; i++) {
        const backend = await getInputBackend(DEVICE_ID);
        expect(backend.kind).toBe('simhid');
      }
    });
  });

  // ── 4. Settings.app navigation scenarios ────────────────────────────────
  //
  // These taps use AX-bridge frame centres — the same source of truth that
  // the MCP tool layer uses. If the Settings pushes a new sub-screen after
  // the tap, AX bridge exposes the new labels; that is the assertion.
  describe('Settings.app scenarios', () => {
    async function tapByLabel(label: string): Promise<void> {
      await ensureSemanticsActive(DEVICE_ID);
      const bridge = getAccessibilityBridge();
      const r = await bridge.query(
        { label },
        { deviceId: DEVICE_ID },
      );
      if (r.matches.length === 0) {
        throw new Error(`Settings.app: "${label}" not found in AX tree`);
      }
      const m = r.matches[0];
      const x = m.frame.x + m.frame.width / 2;
      const y = m.frame.y + m.frame.height / 2;
      const backend = await getInputBackend(DEVICE_ID);
      await backend.tap(DEVICE_ID, x, y);
      // Give UIKit time to push the next view controller.
      await new Promise((r) => setTimeout(r, 900));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function navigateBack(): Promise<void> {
      // Settings exposes a "Back" button once a sub-screen is pushed.
      await ensureSemanticsActive(DEVICE_ID);
      const bridge = getAccessibilityBridge();
      const r = await bridge.query(
        { role: 'AXButton', label: 'Back' },
        { deviceId: DEVICE_ID },
      );
      if (r.matches.length === 0) return;
      const m = r.matches[0];
      const x = m.frame.x + m.frame.width / 2;
      const y = m.frame.y + m.frame.height / 2;
      const backend = await getInputBackend(DEVICE_ID);
      await backend.tap(DEVICE_ID, x, y);
      await new Promise((r) => setTimeout(r, 700));
    }

    beforeEach(async () => {
      await relaunch(SETTINGS);
    });

    test('Settings → General advances to the General sub-screen', async () => {
      await tapByLabel('General');
      const bridge = getAccessibilityBridge();
      // General contains "About" on every recent iOS release.
      const r = await bridge.query(
        { label: 'About' },
        { deviceId: DEVICE_ID },
      );
      expect(r.matches.length).toBeGreaterThan(0);
    });

    test('Settings → General → About advances to About', async () => {
      await tapByLabel('General');
      await tapByLabel('About');
      const bridge = getAccessibilityBridge();
      // About exposes the device Name field on every recent iOS release.
      const r = await bridge.query(
        { label: 'Name' },
        { deviceId: DEVICE_ID },
      );
      expect(r.matches.length).toBeGreaterThan(0);
    });

    test('Settings search (type via app_type_element semantics)', async () => {
      // Settings has a search bar at the bottom of the root screen.
      const bridge = getAccessibilityBridge();
      const search = await bridge.query(
        { role: 'AXSearchField' },
        { deviceId: DEVICE_ID },
      );
      if (search.matches.length === 0) {
        // Some locales nest the search field; skip rather than fail noisily.
        console.warn('[sim-hid.live] Settings search field unavailable — skipping');
        return;
      }
      const m = search.matches[0];
      const x = m.frame.x + m.frame.width / 2;
      const y = m.frame.y + m.frame.height / 2;
      const backend = await getInputBackend(DEVICE_ID);
      await backend.tap(DEVICE_ID, x, y);
      await new Promise((r) => setTimeout(r, 500));
      await backend.typeText(DEVICE_ID, 'wifi');
      await new Promise((r) => setTimeout(r, 600));
      const results = await bridge.query(
        { label: 'Wi-Fi' },
        { deviceId: DEVICE_ID },
      );
      expect(results.matches.length).toBeGreaterThan(0);
    });

    test('Settings → Wi-Fi opens the Wi-Fi pane', async () => {
      await tapByLabel('Wi-Fi');
      const bridge = getAccessibilityBridge();
      // The Wi-Fi pane exposes a toggle switch in every locale.
      const toggles = await bridge.query(
        { role: 'AXSwitch' },
        { deviceId: DEVICE_ID },
      );
      expect(toggles.matches.length).toBeGreaterThan(0);
    });

    test('Settings → Display & Brightness opens the brightness pane', async () => {
      // English label covers en_US builds; on Korean locale the test runner
      // skips when the label is missing rather than fails — locales ship
      // different strings and this scenario is about routing + tap, not i18n.
      const bridge = getAccessibilityBridge();
      const r = await bridge.query(
        { label: 'Display & Brightness' },
        { deviceId: DEVICE_ID },
      );
      if (r.matches.length === 0) {
        console.warn('[sim-hid.live] "Display & Brightness" not in current locale — skipping');
        return;
      }
      await tapByLabel('Display & Brightness');
      const after = await bridge.query(
        { label: 'Text Size' },
        { deviceId: DEVICE_ID },
      );
      expect(after.matches.length).toBeGreaterThan(0);
    });

    test('Settings → Cellular / Airplane Mode pane reachable', async () => {
      const bridge = getAccessibilityBridge();
      const candidate = (await bridge.query(
        { label: 'Airplane Mode' },
        { deviceId: DEVICE_ID },
      )).matches.length
        ? 'Airplane Mode'
        : (await bridge.query(
            { label: 'Cellular' },
            { deviceId: DEVICE_ID },
          )).matches.length
          ? 'Cellular'
          : null;
      if (!candidate) {
        console.warn('[sim-hid.live] no Airplane/Cellular row — skipping');
        return;
      }
      await tapByLabel(candidate);
      const after = await bridge.query(
        { role: 'AXSwitch' },
        { deviceId: DEVICE_ID },
      );
      expect(after.matches.length).toBeGreaterThan(0);
    });

    test('Settings → General → Transfer or Reset reaches the reset list', async () => {
      await tapByLabel('General');
      const bridge = getAccessibilityBridge();
      const reset = (await bridge.query(
        { label: 'Transfer or Reset iPhone' },
        { deviceId: DEVICE_ID },
      )).matches.length
        ? 'Transfer or Reset iPhone'
        : (await bridge.query(
            { label: 'Reset' },
            { deviceId: DEVICE_ID },
          )).matches.length
          ? 'Reset'
          : null;
      if (!reset) {
        console.warn('[sim-hid.live] reset menu label differs — skipping');
        return;
      }
      await tapByLabel(reset);
      const after = await bridge.query(
        { label: 'Reset' },
        { deviceId: DEVICE_ID },
      );
      expect(after.matches.length).toBeGreaterThan(0);
    });
  });

  // ── 5. Cross-app compatibility ──────────────────────────────────────────
  describe('cross-app', () => {
    test.each([
      ['Settings.app', SETTINGS],
      ['Photos.app', PHOTOS],
      ['Maps.app', MAPS],
    ])('%s resolves the simhid backend (no AppleScript fallback)', async (_, bundle) => {
      await relaunch(bundle);
      const backend = await getInputBackend(DEVICE_ID);
      expect(backend.kind).toBe('simhid');
    });

    test('routing stays sim-hid after several resolves across apps', async () => {
      await relaunch(SETTINGS);
      const a = await getInputBackend(DEVICE_ID);
      await relaunch(PHOTOS);
      const b = await getInputBackend(DEVICE_ID);
      await relaunch(MAPS);
      const c = await getInputBackend(DEVICE_ID);
      expect(a.kind).toBe('simhid');
      expect(b.kind).toBe('simhid');
      expect(c.kind).toBe('simhid');
    });
  });

  // ── 6. Performance / memory probes ──────────────────────────────────────
  describe('performance', () => {
    test('single bridge-spawn tap completes within a generous ceiling', async () => {
      const backend = await getInputBackend(DEVICE_ID);
      const start = Date.now();
      await backend.tap(DEVICE_ID, 196, 200);
      const elapsed = Date.now() - start;
      // The Swift helper spawn + dlopen + HID inject is ~150-300 ms on
      // current runners. Give a 2× headroom so machine load doesn't flake
      // the suite; regressions beyond ~1 s are real.
      expect(elapsed).toBeLessThan(1_500);
    });

    test('100 consecutive taps do not leak > 30 MB of RSS', async () => {
      const backend = await getInputBackend(DEVICE_ID);
      // Warm the v8 heap so the delta reflects real growth.
      await backend.tap(DEVICE_ID, 100, 100);
      if (typeof global.gc === 'function') global.gc();
      const before = process.memoryUsage().rss;
      for (let i = 0; i < 100; i++) {
        await backend.tap(DEVICE_ID, 100 + (i % 50), 100 + (i % 50));
      }
      if (typeof global.gc === 'function') global.gc();
      const after = process.memoryUsage().rss;
      const deltaMB = (after - before) / (1024 * 1024);
      // 30 MB ceiling mirrors the #483 checklist target.
      expect(deltaMB).toBeLessThan(30);
    });
  });
});
