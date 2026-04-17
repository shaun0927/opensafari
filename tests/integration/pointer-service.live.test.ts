/**
 * Live integration suite for issue #590 Phase 1 — PointerServiceInputBackend.
 *
 * Exercises the opt-in `sim-hid-bridge tap-ps` routing path end-to-end against
 * the existing Flutter fixture (`tests/integration/fixtures/flutter_sample`)
 * installed on a real booted iOS simulator. Flips two rows in the #590
 * Pre-Deploy checklist:
 *
 *   - Flutter fixture coordinate tap lands (status_label readback)
 *   - Coordinate swipe scrolls Flutter ListView content
 *
 * ## Naming
 *
 * Issue #590 literally references `tests/integration/sim-hid-live-integration.test.ts`
 * but every existing live suite in this directory uses the `.live.test.ts`
 * suffix (`sim-hid-input.live.test.ts`, `flutter-vm-input.live.test.ts`,
 * `issue-423-*.live.test.ts`, …). This file follows the convention.
 *
 * ## Gating
 *
 * The suite is **skipped** unless ALL of the following hold:
 *
 *   - `OPENSAFARI_ENABLE_POINTERSERVICE=1` is set in the environment.
 *     This matches the opt-in Phase-1 routing contract — without the flag
 *     `getInputBackend()` would never return `pointer-service`, so the test
 *     has nothing meaningful to assert.
 *   - The Flutter fixture (bundle id `com.example.osftest` by default) is
 *     installed on the target simulator. The fixture provides the
 *     `status_label` Semantics node and the bare `GestureDetector` region
 *     this test taps on — see
 *     `tests/integration/fixtures/flutter_sample/lib/main.dart` and its
 *     README for the region contract (#590 Phase 1).
 *
 * ## Run
 *
 *   npm run build
 *   cd tests/integration/fixtures/flutter_sample && flutter install --device-id <udid>
 *   OPENSAFARI_ENABLE_POINTERSERVICE=1 OSF_DEVICE_ID=<udid> \
 *     npx jest tests/integration/pointer-service.live.test.ts --runInBand
 *
 * ## Scope vs. related suites
 *
 *   - `tests/unit/pointer-service-input-backend.test.ts` owns the wrapper
 *     contract (argv shape, ok=false handling, JSON parse failures,
 *     env-flag gating) — that layer is fully mocked and runs on every
 *     `npm test`.
 *   - `tests/unit/native-input-backend.test.ts` owns the routing-table
 *     assertion (`getInputBackend` returns `pointer-service` when the env
 *     flag is set and a bridge exists, `simhid` otherwise).
 *   - This file is the **live** complement: it proves the wrapper's argv
 *     actually reaches the simulator, the tap lands on a non-Semantics
 *     region, and the delegated swipe still scrolls.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, symlinkSync, unlinkSync } from 'fs';
import * as path from 'path';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import {
  getInputBackend,
  resetInputBackend,
  tryGetFlutterVMClient,
} from '../../src/tools/native-input-backend';
import {
  PointerServiceInputBackend,
  tryCreatePointerServiceBackend,
  isPointerServiceEnabled,
} from '../../src/tools/pointer-service-input-backend';

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const FLUTTER_BUNDLE =
  process.env.OSF_FLUTTER_BUNDLE_ID ?? 'com.example.osftest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'sim-hid-bridge');
// Mirror `sim-hid-input.live.test.ts`: `tryCreatePointerServiceBackend()`
// probes `<backend-module>/../sim-hid-bridge`, which under ts-jest resolves
// to `src/sim-hid-bridge` — a path that does not exist in the repo. Bridge
// the gap with a test-scoped symlink to the compiled binary under `dist/`.
const PROBE_SYMLINK = path.resolve(REPO_ROOT, 'src', 'sim-hid-bridge');

jest.setTimeout(180_000);

// ─────────────────────────────────────────────────────────────────────────────
// Preconditions for running the suite. Any missing precondition short-circuits
// the entire file through `describe.skip` so the test does not pretend to have
// exercised the PointerService path when it has not.
// ─────────────────────────────────────────────────────────────────────────────

const POINTER_SERVICE_ENABLED = isPointerServiceEnabled();

const FLUTTER_INSTALLED = (() => {
  try {
    const out = execFileSync('xcrun', ['simctl', 'listapps', DEVICE_ID], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return out.includes(`"${FLUTTER_BUNDLE}"`);
  } catch {
    return false;
  }
})();

const BRIDGE_BUILT = existsSync(BRIDGE_PATH);

const SHOULD_RUN =
  POINTER_SERVICE_ENABLED && FLUTTER_INSTALLED && BRIDGE_BUILT;

const describeLive = SHOULD_RUN ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — duplicated from `sim-hid-input.live.test.ts` so this suite stays
// self-contained. `getMouseLocation()` + `pinMouseCursor()` underpin the
// headless-cursor assertion; `frontmostAppName()` underpins the no-focus-theft
// assertion.
// ─────────────────────────────────────────────────────────────────────────────

function getMouseLocation(): { x: number; y: number } {
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
      [
        '-e',
        'tell application "System Events" to get name of first process whose frontmost is true',
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

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

async function readStatusLabel(): Promise<string> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(
    { identifier: 'status_label' },
    { deviceId: DEVICE_ID },
  );
  if (result.matches.length === 0) {
    throw new Error(
      'status_label Semantics node not found — is the Flutter fixture still running?',
    );
  }
  const m = result.matches[0];
  // The Flutter fixture wraps `Text('Status: $_status')` in the Semantics
  // node, so the node's `value` carries the current status payload.
  return (m.value as string | undefined) ?? (m.label as string | undefined) ?? '';
}

async function readFirstRowFrameY(): Promise<number> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(
    { identifier: 'row_item' },
    { deviceId: DEVICE_ID },
  );
  if (result.matches.length === 0) {
    throw new Error(
      'row_item Semantics node not found — is the Flutter fixture still running?',
    );
  }
  return result.matches[0].frame.y;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describeLive(
  'PointerServiceInputBackend — live (#590 Phase 1)',
  () => {
    beforeAll(async () => {
      if (!BRIDGE_BUILT) {
        throw new Error(
          `sim-hid-bridge not found at ${BRIDGE_PATH}. Run \`npm run build\` first.`,
        );
      }
      if (!existsSync(PROBE_SYMLINK)) {
        symlinkSync(BRIDGE_PATH, PROBE_SYMLINK);
      }
      resetInputBackend();

      try {
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
          stdio: 'pipe',
        });
      } catch {
        /* not running — fine */
      }
      execSync(`xcrun simctl launch ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
        stdio: 'pipe',
      });
      await waitForFlutterVM();
    });

    afterAll(() => {
      try {
        unlinkSync(PROBE_SYMLINK);
      } catch {
        /* already gone — fine */
      }
      try {
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
          stdio: 'pipe',
        });
      } catch {
        /* best-effort */
      }
      resetInputBackend();
    });

    test('tryCreatePointerServiceBackend resolves to a PointerServiceInputBackend', async () => {
      const backend = await tryCreatePointerServiceBackend();
      expect(backend).toBeInstanceOf(PointerServiceInputBackend);
      expect(backend?.kind).toBe('pointer-service');
    });

    test(
      'coordinate tap on the bare (non-Semantics) region lands via pointer-service',
      async () => {
        // Baseline: Flutter fixture's `status_label` starts with 'idle'
        // (or `bare:N` from a previous run — we only need monotonic change).
        const before = await readStatusLabel();
        expect(before).toMatch(/^Status: /);

        // The bare region sits right after `status_label` in the ListView,
        // inside 16 pt padding on both sides. Tapping at mid-width / a Y
        // coordinate inside the amber container reliably hits it: ListView
        // padding=16, status_label ≈ 20 pt, SizedBox=12, then a 120-pt
        // container. Y ≈ 16 + 20 + 12 + 60 = 108 from the top of the
        // SafeArea content, shifted by the iOS status bar (~59 pt on
        // iPhone 17 Pro) plus AppBar (~44 pt) → aim at y = 210.
        //
        // The *exact* Y is fixture-dependent; the test runs against a
        // stable fixture, so a tolerance of ±40 pt around 210 is fine
        // because the container itself is 120 pt tall.
        const backend = await tryCreatePointerServiceBackend();
        if (!backend) {
          throw new Error(
            'tryCreatePointerServiceBackend returned null — PROBE_SYMLINK missing?',
          );
        }

        const PIN_X = 50;
        const PIN_Y = 50;
        pinMouseCursor(PIN_X, PIN_Y);
        const mouseBefore = getMouseLocation();

        await backend.tap(DEVICE_ID, 200, 210);

        // The Flutter fixture updates `_status = 'bare:<count>'` inside
        // setState, which propagates through the Semantics tree on the
        // next frame. Poll for up to 5 s to tolerate frame latency.
        const deadline = Date.now() + 5_000;
        let after = before;
        while (Date.now() < deadline) {
          after = await readStatusLabel();
          if (after !== before && /bare:\d+/.test(after)) break;
          await new Promise((r) => setTimeout(r, 250));
        }

        const mouseAfter = getMouseLocation();
        const dx = Math.abs(mouseAfter.x - mouseBefore.x);
        const dy = Math.abs(mouseAfter.y - mouseBefore.y);

        // eslint-disable-next-line no-console
        console.error(
          `[pointer-service] status_label before="${before}" after="${after}" ` +
            `cursor Δ=(${dx},${dy}) frontmost="${frontmostAppName()}"`,
        );

        expect(after).toMatch(/bare:\d+/);
        expect(dx).toBeLessThan(1);
        expect(dy).toBeLessThan(1);
        expect(frontmostAppName().toLowerCase()).not.toContain('simulator');
      },
    );

    test(
      'coordinate swipe scrolls the Flutter ListView (delegated swipe contract)',
      async () => {
        // Scroll the ListView by swiping upward; assert the first `row_item`
        // frame.y decreases (content scrolls up under the viewport).
        const beforeY = await readFirstRowFrameY();

        const backend = await tryCreatePointerServiceBackend();
        if (!backend) {
          throw new Error(
            'tryCreatePointerServiceBackend returned null — PROBE_SYMLINK missing?',
          );
        }

        // swipe() delegates to SimulatorKitHIDInputBackend per the Phase-1
        // contract (there is no `swipe-ps` subcommand yet) — that is the
        // path under test here.
        await backend.swipe(DEVICE_ID, 220, 600, 220, 200, 0.3);

        // Let the scroll settle.
        await new Promise((r) => setTimeout(r, 600));

        const afterY = await readFirstRowFrameY();
        const delta = beforeY - afterY;

        // eslint-disable-next-line no-console
        console.error(
          `[pointer-service] row_item.frame.y before=${beforeY} after=${afterY} Δ=${delta}`,
        );

        expect(delta).toBeGreaterThanOrEqual(100);
      },
    );

    test(
      'getInputBackend returns pointer-service when Flutter Tier 0 declines',
      async () => {
        // Terminate the Flutter fixture so Tier 0 (FlutterVMInputBackend)
        // caches a negative hit, then the PointerService opt-in tier wins.
        // This is the last test in the suite because it leaves the fixture
        // terminated; afterAll does its best-effort cleanup anyway.
        execSync(`xcrun simctl terminate ${DEVICE_ID} ${FLUTTER_BUNDLE}`, {
          stdio: 'pipe',
        });

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

        const backend = await getInputBackend(DEVICE_ID);
        expect(backend.kind).toBe('pointer-service');
      },
    );
  },
);

// Log once at load-time so the reason for a skipped suite is visible in the
// jest output without needing to enable verbose mode.
if (!SHOULD_RUN) {
  const reasons: string[] = [];
  if (!POINTER_SERVICE_ENABLED)
    reasons.push('OPENSAFARI_ENABLE_POINTERSERVICE is not set to 1/true');
  if (!FLUTTER_INSTALLED)
    reasons.push(`${FLUTTER_BUNDLE} is not installed on ${DEVICE_ID}`);
  if (!BRIDGE_BUILT)
    reasons.push(`dist/sim-hid-bridge is missing (run npm run build)`);
  // eslint-disable-next-line no-console
  console.error(
    `[pointer-service.live] suite skipped: ${reasons.join('; ')}`,
  );
}
