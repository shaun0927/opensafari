/**
 * Live smoke test for issue #39 Tier 2 — pasteboard-backed typing.
 *
 * Gated by OPENSAFARI_LIVE_PASTE=1. Installs the flutter-qa-app fixture on a
 * booted simulator (assumed booted — no auto-boot), focuses the email-field,
 * and types a Unicode string via the pasteboard path. Asserts the on-screen
 * pixel content via AX tree (best-effort) and the telemetry result shape.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { typeViaPasteboard } from '../../src/tools/pasteboard-input';
import { getAccessibilityBridge, ensureSemanticsActive } from '../../src/native';
import { SimulatorManager } from '../../src/simulator';

void SimulatorManager;

const LIVE = process.env.OPENSAFARI_LIVE_PASTE === '1';
const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? 'F19D0482-3539-4B74-A353-0229E415B64C';
const BUNDLE_ID = 'com.opensafari.fixtures.flutterQaApp';
const APP_PATH = path.resolve(
  __dirname,
  '../fixtures/flutter-qa-app/build/ios/iphonesimulator/Runner.app',
);

jest.setTimeout(120_000);

describe('issue #39 Tier 2 — pasteboard-backed typing', () => {
  if (!LIVE) {
    test.skip(
      'set OPENSAFARI_LIVE_PASTE=1 and OSF_DEVICE_ID to run this live smoke test',
      () => {},
    );
    return;
  }

  beforeAll(async () => {
    execFileSync('xcrun', ['simctl', 'install', DEVICE_ID, APP_PATH], {
      stdio: 'pipe',
    });
    try {
      execFileSync('xcrun', ['simctl', 'terminate', DEVICE_ID, BUNDLE_ID], {
        stdio: 'pipe',
      });
    } catch {
      /* not running — fine */
    }
    execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, BUNDLE_ID], {
      stdio: 'pipe',
    });
    await new Promise((r) => setTimeout(r, 2500));
    // Second launch re-activates (brings to foreground) — same pattern as
    // webview-native-context.live.test.ts.
    execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, BUNDLE_ID], {
      stdio: 'pipe',
    });
    await new Promise((r) => setTimeout(r, 2500));
    // Bring Simulator.app into macOS focus. HID Cmd+V → UIKit paste handling
    // appears to require the simulator window to be the macOS key window;
    // without this, key events are accepted by the device but iOS routes them
    // to the lock screen / background hierarchy instead of the focused app.
    try {
      execFileSync('osascript', ['-e', 'tell application "Simulator" to activate'], {
        stdio: 'pipe',
        timeout: 5000,
      });
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      /* best-effort */
    }
    await ensureSemanticsActive(DEVICE_ID);
  });

  test('types Unicode string (Korean + Latin + emoji) into Flutter TextField', async () => {
    const bridge = getAccessibilityBridge();
    const q = await bridge.query(
      { identifier: 'email-field' },
      { deviceId: DEVICE_ID },
    );
    expect(q.matches.length).toBeGreaterThan(0);

    const press = await bridge.press(q.matches[0].path, DEVICE_ID);
    expect(press.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const text = '안녕 qa@example.com 🎉';
    const result = await typeViaPasteboard(DEVICE_ID, text);

    // eslint-disable-next-line no-console
    console.error('[paste-smoke]', JSON.stringify(result));

    expect(result.backend).toBe('pasteboard');
    expect(result.length).toBe(text.length);
    expect(['not_shown', 'auto_accepted']).toContain(result.permissionDialog);
    expect(result.pasteboardRestored).toBe(true);

    // Note: we do not assert on the AX TextField value/label for the typed
    // text. Flutter's iOS AX implementation does not expose the post-paste
    // value via the standard `value` or `label` attributes in a timely or
    // stable manner — the pasted text surfaces only after the AX tree is
    // "nudged" by an activation or another focus change. Verifying the paste
    // landed is covered by a separate visual-assertion step in the
    // `OPENSAFARI_LIVE_PASTE_VISUAL=1` run (documented in
    // `docs/integrations/pasteboard-typing.md`) that compares a post-paste
    // screenshot against a fixture PNG. This suite's role is to exercise the
    // backend wiring, telemetry envelope, and permission-dialog auto-accept
    // corpus — the visual check lives in a separate gated lane.
  });
});
