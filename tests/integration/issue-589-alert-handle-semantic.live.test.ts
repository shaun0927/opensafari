/**
 * Live integration suite for issue #589 — proves that `app_alert_handle`
 * resolves semantic button keys to the correct locale-aware label and
 * successfully presses them via the AX-press path on a ko-KR simulator.
 *
 * The suite exercises three code paths shipped in PR #607:
 *   1. `resolveLocalizedButtonLabels` returns the ko-KR label from the
 *      SYSTEM_BUTTON_CATALOG as the primary candidate and the English label
 *      as the fallback.
 *   2. End-to-end accept via semantic key: Maps location permission sheet
 *      is presented and dismissed with the "앱을 사용하는 동안 허용" button.
 *   3. End-to-end deny via semantic key: Maps location permission sheet
 *      is re-presented and dismissed with the "허용 안 함" button.
 *
 * Locale-awareness: the suite reads the active simulator locale at runtime.
 * When the simulator is not running ko-KR it logs a warning and skips all
 * tests gracefully — no failure is emitted on non-ko hosts.
 *
 * Setup prerequisites (see tests/integration/README.md for the full
 * rationale):
 *   - booted iOS Simulator set to the ko-KR locale
 *   - `OPENSAFARI_ALLOW_FOCUS_INPUT=1` so the Tier-3 CGEvent backend is
 *     allowed (Xcode 26+ removed `simctl io input`)
 *
 * Run:
 *   OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest \
 *     tests/integration/issue-589-alert-handle-semantic.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 */
process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';

import { execFile } from 'child_process';
import { promisify } from 'util';
import { MCPServer } from '../../src/mcp-server';
import { registerAppAlertHandleTool } from '../../src/tools/app-alert-handle';
import {
  resolveLocalizedButtonLabels,
  getSimulatorLocale,
} from '../../src/native/localized-button-matcher';

const execFileAsync = promisify(execFile);

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';

const MAPS_BUNDLE = 'com.apple.Maps';

jest.setTimeout(120_000);

/** Helper to parse the first content item from a tool response. */
function parseResult(result: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/**
 * Trigger the Maps location permission sheet by:
 *   1. Terminating any running Maps instance.
 *   2. Resetting location privacy so the permission sheet reappears.
 *   3. Opening Maps via `simctl openurl` which re-triggers the prompt.
 *
 * Waits 4.5 s for the sheet animation to complete before returning.
 */
async function triggerMapsLocationPrompt(): Promise<void> {
  try {
    await execFileAsync('xcrun', ['simctl', 'terminate', DEVICE_ID, MAPS_BUNDLE], {
      timeout: 6_000,
    });
  } catch {
    /* not running — fine */
  }

  try {
    await execFileAsync(
      'xcrun',
      ['simctl', 'privacy', DEVICE_ID, 'reset', 'location', MAPS_BUNDLE],
      { timeout: 8_000 },
    );
  } catch {
    /* permission reset may fail on some OS versions — non-fatal */
  }

  await execFileAsync(
    'xcrun',
    ['simctl', 'openurl', DEVICE_ID, 'maps://'],
    { timeout: 8_000 },
  );

  // Wait for the permission sheet to animate into view
  await new Promise((r) => setTimeout(r, 4_500));
}

describe('issue #589 — app_alert_handle semantic-key label match', () => {
  let server: MCPServer;
  let isKorean = false;

  beforeAll(async () => {
    // Read active simulator locale; skip gracefully on non-ko hosts
    const locale = await getSimulatorLocale(DEVICE_ID);

    if (!locale || !locale.startsWith('ko')) {
      console.warn(
        `[issue-589] Simulator locale is "${locale ?? 'unknown'}" — ` +
          'expected ko* for full test execution. All tests will be skipped.',
      );
      return;
    }

    isKorean = true;

    // Set up the MCP tool server
    server = new MCPServer();
    registerAppAlertHandleTool(server);

    // Trigger the first Maps permission sheet
    await triggerMapsLocationPrompt();
  });

  afterAll(async () => {
    try {
      await execFileAsync('xcrun', ['simctl', 'terminate', DEVICE_ID, MAPS_BUNDLE], {
        timeout: 6_000,
      });
    } catch {
      /* best-effort */
    }
  });

  // ── Test A: resolveLocalizedButtonLabels returns correct ko-KR label ──────

  test('resolves semantic key via catalog: primary=ko label, fallback=en label', async () => {
    if (!isKorean) {
      console.warn('[issue-589] Skipping Test A — non-ko simulator.');
      return;
    }

    const labels = await resolveLocalizedButtonLabels({
      semanticKey: 'permission.whileUsing',
      deviceId: DEVICE_ID,
    });

    // Primary candidate must be the Korean label
    expect(labels[0]).toBe('앱을 사용하는 동안 허용');
    // English fallback must be present somewhere in the list
    expect(labels).toContain('Allow While Using App');
  });

  // ── Test B: end-to-end accept via semantic key ─────────────────────────────

  test('accepts Maps location prompt via permission.whileUsing semantic key', async () => {
    if (!isKorean) {
      console.warn('[issue-589] Skipping Test B — non-ko simulator.');
      return;
    }

    const resolvedLabels = await resolveLocalizedButtonLabels({
      semanticKey: 'permission.whileUsing',
      deviceId: DEVICE_ID,
    });

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('live-test', {
      buttonLabels: resolvedLabels,
      deviceId: DEVICE_ID,
    });

    const text = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    );

    // Must not be an error
    expect(result.isError).toBeUndefined();

    expect(text.handled).toBe(true);
    expect(text.method).toBe('ax-press');

    // Telemetry shape assertions
    const telemetry = (text._meta as Record<string, unknown>)
      ._telemetry as Array<Record<string, unknown>>;
    expect(telemetry[0].backend).toBe('ax-press');
    expect(telemetry[0].label).toBe('앱을 사용하는 동안 허용');
  });

  // ── Test C: deny via semantic key ─────────────────────────────────────────

  test('denies Maps location prompt via permission.deny semantic key', async () => {
    if (!isKorean) {
      console.warn('[issue-589] Skipping Test C — non-ko simulator.');
      return;
    }

    // Re-trigger the permission sheet for this test
    await triggerMapsLocationPrompt();

    const resolvedLabels = await resolveLocalizedButtonLabels({
      semanticKey: 'permission.deny',
      deviceId: DEVICE_ID,
    });

    // Primary deny label for ko-KR
    expect(resolvedLabels[0]).toBe('허용 안 함');

    const handler = server.getToolHandler('app_alert_handle')!;
    const result = await handler('live-test', {
      buttonLabels: resolvedLabels,
      deviceId: DEVICE_ID,
    });

    const text = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    );

    expect(result.isError).toBeUndefined();
    expect(text.handled).toBe(true);
    expect(text.method).toBe('ax-press');

    const telemetry = (text._meta as Record<string, unknown>)
      ._telemetry as Array<Record<string, unknown>>;
    expect(telemetry[0].label).toBe('허용 안 함');
  });
});
