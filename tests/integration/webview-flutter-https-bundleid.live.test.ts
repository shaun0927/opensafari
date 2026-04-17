/**
 * Live integration suite for issue #592 — bundle-aware HTTPS WebView
 * classification via `app_webview_connect`.
 *
 * Scenario under test:
 *   A native iOS app embeds `webview_flutter` and loads `https://example.com`.
 *   Before #592, such a target was misclassified as `safari` by the URL-scheme
 *   heuristic. With the bundle-aware classifier in place, passing the host
 *   app's bundle id must:
 *     - promote the target to `type: 'webview'`
 *     - surface `classificationReason: 'bundle_match'`
 *     - keep the target's HTTPS `url` intact in the response
 *
 * Opt-in only. Ignored by `npm test` (jest.config.js excludes
 * `tests/integration/`). To run locally:
 *
 *   1. Install the HTTPS webview_flutter fixture on a booted simulator
 *      (bundle id: `com.opensafari.fixtures.webviewhttps`). The fixture is
 *      tracked separately from this PR — this file is the verification
 *      harness, not the fixture itself.
 *   2. Start ios-webkit-debug-proxy:
 *        ios_webkit_debug_proxy -c <UDID>:9322
 *   3. Run:
 *        OPENSAFARI_LIVE_WEBVIEW_HTTPS=1 OSF_DEVICE_ID=<UDID> \
 *          npx jest tests/integration/webview-flutter-https-bundleid.live.test.ts \
 *          --runInBand --testPathIgnorePatterns=/node_modules/
 *
 * Environment variables:
 *   OPENSAFARI_LIVE_WEBVIEW_HTTPS — must be '1' to opt in.
 *   OSF_DEVICE_ID                 — UDID of the target simulator (required).
 *   OPENSAFARI_PROXY_PORT         — ios-webkit-debug-proxy port (default: 9322).
 *
 * Refs: #592 (bundle-aware target classification).
 */

import { execFileSync } from 'child_process';
import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerAppWebviewConnectTool } from '../../src/tools/app-webview-connect';
import { WebKitClient } from '../../src/webkit/client';

/* ─── Environment ──────────────────────────────────────────────────── */

const LIVE = process.env.OPENSAFARI_LIVE_WEBVIEW_HTTPS === '1';
const DEVICE_ID = process.env.OSF_DEVICE_ID ?? '';
const BUNDLE_ID = 'com.opensafari.fixtures.webviewhttps';
const PROXY_HOST = 'localhost';
const PROXY_PORT = parseInt(process.env.OPENSAFARI_PROXY_PORT ?? '9322', 10);
const FIXTURE_URL = 'https://example.com/';

jest.setTimeout(180_000);

/* ─── Helpers ──────────────────────────────────────────────────────── */

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

describe('issue #592 — HTTPS WebView bundle_match via app_webview_connect', () => {
  if (!LIVE) {
    test.skip(
      'set OPENSAFARI_LIVE_WEBVIEW_HTTPS=1 and OSF_DEVICE_ID=<UDID> to run the bundle_match harness',
      () => {},
    );
    return;
  }

  if (!DEVICE_ID) {
    test('OSF_DEVICE_ID must be set when OPENSAFARI_LIVE_WEBVIEW_HTTPS=1', () => {
      expect(DEVICE_ID).not.toBe('');
    });
    return;
  }

  let server: MCPServer;
  let client: WebKitClient;

  beforeAll(async () => {
    launchFixture();
    await new Promise((r) => setTimeout(r, 3000));

    server = new MCPServer();
    registerAppWebviewConnectTool(server);

    client = new WebKitClient({ host: PROXY_HOST, port: PROXY_PORT });
    setWebKitClient(client);
  });

  afterAll(async () => {
    try {
      await client?.disconnect();
    } catch {
      /* best-effort */
    }
    setWebKitClient(null);
    terminateFixture();
  });

  test('app_webview_connect({ bundleId }) promotes HTTPS target to webview + bundle_match', async () => {
    const handler = server.getToolHandler('app_webview_connect');
    if (!handler) throw new Error('app_webview_connect handler not registered');

    // Poll briefly — the WebView may take a moment to attach after launch.
    let targets: Array<{
      id: string;
      title: string;
      url: string;
      type: string;
      classificationReason: string;
    }> = [];
    let bundleMatch: (typeof targets)[number] | undefined;

    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await handler('test', { bundleId: BUNDLE_ID });
      if (result.isError) {
        throw new Error(
          `app_webview_connect returned error: ${(result.content as Array<{ text: string }>)[0]?.text}`,
        );
      }

      const data = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text,
      );
      targets = data.targets;
      bundleMatch = targets.find(
        (t) => t.classificationReason === 'bundle_match',
      );
      if (bundleMatch) break;

      await new Promise((r) => setTimeout(r, 1000));
    }

    // eslint-disable-next-line no-console
    console.error(
      `[webview-flutter-https-bundleid] targets=${JSON.stringify(targets, null, 2)}`,
    );

    // Loud failure if the fixture isn't installed or hasn't surfaced a
    // bundle-matched WebView — a silent skip would hide a real regression.
    expect(bundleMatch).toBeDefined();
    expect(bundleMatch!.type).toBe('webview');
    expect(bundleMatch!.classificationReason).toBe('bundle_match');
    expect(bundleMatch!.url.startsWith('https://')).toBe(true);

    // eslint-disable-next-line no-console
    console.error(
      `[webview-flutter-https-bundleid] bundle_match: id=${bundleMatch!.id} url=${bundleMatch!.url} (fixture URL: ${FIXTURE_URL})`,
    );
  });
});
