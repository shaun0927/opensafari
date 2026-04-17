/**
 * Live integration suite for issue #593 — WebView↔Native cross-context E2E.
 *
 * Exercises the full native→webview→native bounce:
 *
 *   1. Builds and installs the webview_flutter_bridge fixture app.
 *   2. Launches the fixture via `simctl launch`.
 *   3. AX-presses `load_webview_btn` to render the embedded WebView.
 *   4. Discovers the WebView target via ios-webkit-debug-proxy.
 *   5. Connects to the WebView, asserts heading text, and clicks a DOM button.
 *   6. Disconnects and bounces back to native — AX-presses `native_confirm_btn`
 *      and polls until `native_status_text` reads "confirmed".
 *   7. Surfaces an RSS memory delta (non-fatal) so CI logs show the number.
 *
 * **Opt-in only.** Ignored by `npm test` (jest.config.js excludes
 * `tests/integration/`). To run locally:
 *
 *   1. Boot an iPhone simulator.
 *   2. Start ios-webkit-debug-proxy:
 *        ios_webkit_debug_proxy -c <UDID>:9322
 *   3. Run:
 *        OPENSAFARI_LIVE_WEBVIEW=1 OSF_DEVICE_ID=<UDID> \
 *          npx jest tests/integration/webview-native-context.live.test.ts \
 *          --runInBand --testPathIgnorePatterns=/node_modules/
 *
 * Environment variables:
 *   OPENSAFARI_LIVE_WEBVIEW  — must be '1' to opt in
 *   OSF_DEVICE_ID            — UDID of the target simulator (required)
 *   OPENSAFARI_PROXY_PORT    — ios-webkit-debug-proxy port (default: 9322)
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { WebKitClient } from '../../src/webkit/client';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import { resetInputBackend } from '../../src/tools/native-input-backend';

/* ─── Environment ──────────────────────────────────────────────────── */

const LIVE = process.env.OPENSAFARI_LIVE_WEBVIEW === '1';
const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const BUNDLE_ID = 'com.opensafari.fixtures.webviewbridge';
const PROXY_HOST = 'localhost';
const PROXY_PORT = parseInt(
  process.env.OPENSAFARI_PROXY_PORT ?? '9322',
  10,
);

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../tests/fixtures/webview_flutter_bridge',
);
const BUILD_SCRIPT = path.join(FIXTURE_DIR, 'build.sh');

jest.setTimeout(240_000);

/* ─── Helpers ──────────────────────────────────────────────────────── */

/**
 * Classify a target URL: file:// or custom scheme → webview; http(s) → safari.
 * Bundle-aware classification is exercised separately in
 * webview-flutter-https-bundleid.live.test.ts (#592); this helper remains as
 * the simple URL fallback used by this file:// Flutter bridge fixture.
 */
function isWebViewUrl(url: string): boolean {
  if (!url || url === 'about:blank') return false;
  return !url.startsWith('http://') && !url.startsWith('https://');
}

function launchFixture(): void {
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
}

function terminateFixture(): void {
  try {
    execFileSync('xcrun', ['simctl', 'terminate', DEVICE_ID, BUNDLE_ID], {
      stdio: 'pipe',
    });
  } catch {
    /* best-effort */
  }
}

/* ─── Suite ────────────────────────────────────────────────────────── */

describe('issue #593 — WebView↔Native cross-context E2E', () => {
  if (!LIVE) {
    test.skip(
      'set OPENSAFARI_LIVE_WEBVIEW=1 and OSF_DEVICE_ID=<UDID> to run WebView↔Native E2E tests',
      () => {},
    );
    return;
  }

  let webkitClient: WebKitClient;
  const rssAtStart = process.memoryUsage().rss;

  beforeAll(async () => {
    // Build + install the Flutter fixture
    execFileSync(
      '/bin/sh',
      [BUILD_SCRIPT, '--install', '--device-id', DEVICE_ID],
      { timeout: 180_000, stdio: 'pipe' },
    );

    launchFixture();
    // Wait for the app process to start, then re-launch to bring it to the
    // foreground (same pattern as webview-smoke.live.test.ts).
    await new Promise((r) => setTimeout(r, 3000));
    execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, BUNDLE_ID], {
      stdio: 'pipe',
    });
    await new Promise((r) => setTimeout(r, 3000));

    resetInputBackend();
    await ensureSemanticsActive(DEVICE_ID);
  });

  afterAll(async () => {
    if (webkitClient) {
      await webkitClient.disconnect().catch(() => {});
    }
    terminateFixture();
    resetInputBackend();

    // ── Memory soak regression surface (test 5) ──────────────────────
    // Not a hard assertion — surfaces the delta so CI logs capture it.
    // The 100 MB hard check is handled by the nightly sentinel.
    const rssDelta = process.memoryUsage().rss - rssAtStart;
    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] RSS delta across suite: ${(rssDelta / 1024 / 1024).toFixed(1)} MB`,
    );
  });

  // ─── Test 1: AX press on load_webview_btn shows the WebView ────────

  test('AX press on load_webview_btn launches the embedded WebView', async () => {
    webkitClient = new WebKitClient({ host: PROXY_HOST, port: PROXY_PORT });

    const bridge = getAccessibilityBridge();
    const result = await bridge.query(
      { identifier: 'load_webview_btn' },
      { deviceId: DEVICE_ID },
    );
    expect(result.matches.length).toBeGreaterThan(0);

    const match = result.matches[0];
    const pressResult = await bridge.press(match.path, DEVICE_ID);
    expect(pressResult.ok).toBe(true);

    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] AX press load_webview_btn: ok=${pressResult.ok}, code=${pressResult.code}`,
    );

    // Poll for a WebView target (file:// URL from Flutter asset) up to 30 s.
    // Bundle-aware classification is covered by
    // webview-flutter-https-bundleid.live.test.ts (#592); this fixture loads
    // a file:// asset so url_scheme matches directly.
    let webviewTarget:
      | { id: string; title: string; url: string; webSocketDebuggerUrl: string }
      | undefined;
    for (let i = 0; i < 30; i++) {
      const targets = await webkitClient.listTargets();
      webviewTarget = targets.find(
        (t) =>
          isWebViewUrl(t.url) ||
          t.title.includes('Bridge Fixture') ||
          t.title.includes('OpenSafari Bridge Fixture'),
      );
      if (webviewTarget) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(webviewTarget).toBeDefined();
    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] WebView target: url="${webviewTarget!.url}", title="${webviewTarget!.title}"`,
    );
  });

  // ─── Test 2: Context-switch + DOM eval round-trip ──────────────────

  test('context-switch + DOM eval round-trip — heading text is "WebView Bridge"', async () => {
    const targets = await webkitClient.listTargets();
    const wvTarget = targets.find(
      (t) =>
        isWebViewUrl(t.url) ||
        t.title.includes('Bridge Fixture') ||
        t.title.includes('OpenSafari Bridge Fixture'),
    );
    expect(wvTarget).toBeDefined();

    await webkitClient.connectToUrl(wvTarget!.webSocketDebuggerUrl);

    const result = await webkitClient.send<{
      result: { type: string; value: string };
    }>('Runtime.evaluate', {
      expression: 'document.getElementById("heading").textContent',
    });

    expect(result.result.type).toBe('string');
    expect(result.result.value).toBe('WebView Bridge');

    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] DOM heading: "${result.result.value}"`,
    );
  });

  // ─── Test 3: In-WebView click mutates DOM ──────────────────────────

  test('in-WebView click mutates DOM — web-info becomes "clicked"', async () => {
    const clickResult = await webkitClient.send<{
      result: { type: string; value: string };
    }>('Runtime.evaluate', {
      expression: `
        document.getElementById('web-action').click();
        document.getElementById('web-info').textContent;
      `,
    });

    expect(clickResult.result.value).toBe('clicked');

    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] In-WebView click: web-info="${clickResult.result.value}"`,
    );
  });

  // ─── Test 4: Bounce back to native ─────────────────────────────────

  test('bounce back to native — native_confirm_btn sets native_status_text to "confirmed"', async () => {
    await webkitClient.disconnect().catch(() => {});

    const bridge = getAccessibilityBridge();
    const btnResult = await bridge.query(
      { identifier: 'native_confirm_btn' },
      { deviceId: DEVICE_ID },
    );
    expect(btnResult.matches.length).toBeGreaterThan(0);

    const pressResult = await bridge.press(
      btnResult.matches[0].path,
      DEVICE_ID,
    );
    expect(pressResult.ok).toBe(true);

    // eslint-disable-next-line no-console
    console.error(
      `[webview-native-context] AX press native_confirm_btn: ok=${pressResult.ok}`,
    );

    // Poll native_status_text until value === 'confirmed' (10 s max)
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      const statusResult = await bridge.query(
        { identifier: 'native_status_text' },
        { deviceId: DEVICE_ID },
      );
      if (statusResult.matches.length > 0) {
        const m = statusResult.matches[0] as { value?: string; label?: string };
        // eslint-disable-next-line no-console
        console.error(
          `[webview-native-context] native_status_text poll ${i + 1}: value="${m.value}" label="${m.label}"`,
        );
        if (m.value === 'confirmed' || m.label === 'confirmed') {
          confirmed = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(confirmed).toBe(true);
  });
});
