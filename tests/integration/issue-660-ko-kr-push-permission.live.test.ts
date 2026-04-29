/**
 * Live integration suite for issue #660 — verifies the Exit criteria for the
 * ko-KR `UNUserNotificationCenter` permission sheet:
 *
 *   1. `app_handle_alert { action: "dismiss" }` returns
 *      `dismissed: true, strategy: "ax-scan"`
 *   2. `visibleButtons` contains the localized labels (`허용`, `허용 안 함`)
 *   3. `ax-bridge-native dump --debug` exits 0 and the walker debug events
 *      added in PR C-prime (`walker_overlay_roles_seen`,
 *      `walker_app_windows_enumerated`) emit non-degenerate values
 *
 * The suite is gated behind explicit opt-in env vars because the cold-launch
 * step requires:
 *
 *   - A booted ko-KR iOS simulator (`OSF_DEVICE_ID`)
 *   - A Flutter app that re-prompts notification authorization on cold launch
 *     (`OSF_PERMISSION_BUNDLE`)
 *   - Host shell with Full Disk Access so `simctl privacy reset notifications`
 *     succeeds — see `docs/recipes/transient-simctl-errors.md`. Without FDA,
 *     the simctl call fails with NSPOSIXErrorDomain code 1 ("Operation not
 *     permitted") and the suite cannot establish the precondition.
 *
 * The default behavior (no opt-in) is "skip with a structured warning".
 * That keeps CI green on hosts that lack the FDA grant while preserving a
 * one-line opt-in for any focused session that does have the grant.
 *
 * Once opt-in is set, environmental failures (TCC reset failure, missing
 * sheet, empty tool body) throw rather than soft-skipping. The operator
 * who flipped the opt-in env var has committed to having a working
 * environment, so a degraded environment is a setup error that must be
 * surfaced rather than masked.
 *
 * Run:
 *   OPENSAFARI_KOKR_PUSH_DIALOG=1 \
 *   OSF_DEVICE_ID=<UDID-of-ko-KR-iOS-26.4-sim> \
 *   OSF_PERMISSION_BUNDLE=com.example.flutterApp \
 *     npx jest tests/integration/issue-660-ko-kr-push-permission.live.test.ts \
 *     --runInBand
 */

import { execFileSync, spawnSync } from 'child_process';
import path from 'path';

import { MCPServer } from '../../src/mcp-server';
import { registerAppHandleAlertTool } from '../../src/tools/app-handle-alert';

/* ─── Constants ─────────────────────────────────────────────────────── */

const OPT_IN_ENV = 'OPENSAFARI_KOKR_PUSH_DIALOG';
const DEVICE_ID = process.env.OSF_DEVICE_ID ?? '';
const BUNDLE_ID = process.env.OSF_PERMISSION_BUNDLE ?? '';
/** ko-KR localized labels for the UNUserNotificationCenter permission sheet. */
const ACCEPT_LABEL = '허용';
const DISMISS_LABEL = '허용 안 함';
/** How long to wait for the SpringBoard permission sheet to appear (ms). */
const SHEET_WAIT_MS = 12_000;
/** Path to the bundled native bridge binary (built by `npm run build`). */
const AX_BRIDGE_BIN = path.resolve(__dirname, '../../dist/ax-bridge-native');

/**
 * `app_handle_alert#collectVisibleButtonLabels` annotates non-ASCII whitespace
 * as `"<original> (norm: <normalized>)"` (slice 2 of #642). Strict equality
 * against `허용 안 함` would falsely miss when the diagnostic suffix is
 * present. Mirror the regex from `src/tools/app-handle-alert.ts` so the
 * assertion compares against the raw label.
 */
const DIAGNOSTIC_ANNOTATION_SUFFIX = / \(norm: [^)]*\)$/;

function stripDiagnosticAnnotation(label: string): string {
  return label.replace(DIAGNOSTIC_ANNOTATION_SUFFIX, '');
}

/**
 * Normalize Unicode whitespace (NBSP, fullwidth space, etc.) to ASCII space
 * so a label captured from a SpringBoard sheet that uses U+00A0 between
 * syllables still equality-matches the constant `허용 안 함` written here as
 * a plain ASCII-spaced string.
 */
function normalizeWhitespace(label: string): string {
  return label.replace(/\s+/gu, ' ').trim();
}

function canonicalLabel(label: string): string {
  return normalizeWhitespace(stripDiagnosticAnnotation(label));
}

jest.setTimeout(180_000);

/* ─── Skip-gate helpers ─────────────────────────────────────────────── */

function shouldRun(): { run: boolean; reason: string } {
  if (process.env[OPT_IN_ENV] !== '1') {
    return {
      run: false,
      reason: `${OPT_IN_ENV} not set; suite is opt-in because the perm reset requires host Full Disk Access.`,
    };
  }
  if (!DEVICE_ID) {
    return {
      run: false,
      reason: 'OSF_DEVICE_ID not set; cannot target a specific ko-KR sim.',
    };
  }
  if (!BUNDLE_ID) {
    return {
      run: false,
      reason: 'OSF_PERMISSION_BUNDLE not set; cannot cold-launch the Flutter app under test.',
    };
  }
  return { run: true, reason: '' };
}

/* ─── Cold-launch + sheet-wait helpers ──────────────────────────────── */

interface ResetOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * Reset notification authorization for the target bundle. Returns
 * `{ ok: false }` with a reason on the documented TCC failure so the test
 * can skip cleanly instead of hard-failing on a host environment issue.
 */
function resetNotifications(): ResetOutcome {
  const result = spawnSync(
    '/usr/bin/xcrun',
    ['simctl', 'privacy', DEVICE_ID, 'reset', 'notifications', BUNDLE_ID],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return { ok: true };

  const stderr = result.stderr ?? '';
  if (stderr.includes('Operation not permitted')) {
    return {
      ok: false,
      reason:
        'simctl privacy reset returned "Operation not permitted" — host shell lacks Full Disk Access for the simulator TCC sandbox. See docs/recipes/transient-simctl-errors.md.',
    };
  }
  return {
    ok: false,
    reason: `simctl privacy reset exited with code ${result.status}: ${stderr.trim()}`,
  };
}

function terminateApp(): void {
  try {
    execFileSync('/usr/bin/xcrun', ['simctl', 'terminate', DEVICE_ID, BUNDLE_ID], {
      stdio: 'pipe',
    });
  } catch {
    /* not running — fine */
  }
}

function launchApp(): void {
  execFileSync('/usr/bin/xcrun', ['simctl', 'launch', DEVICE_ID, BUNDLE_ID], {
    stdio: 'pipe',
  });
}

/**
 * Capture stderr from `ax-bridge-native dump --debug` once. Stdout is
 * discarded; we only care that the exit code is 0 and the stderr stream
 * contains the new walker_* events.
 */
function captureDebugStderr(): { exitCode: number; stderr: string } {
  const result = spawnSync(
    AX_BRIDGE_BIN,
    ['dump', '--device', DEVICE_ID, '--debug'],
    { encoding: 'utf8' },
  );
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
  };
}

interface DebugEvent {
  event: string;
  [key: string]: unknown;
}

function parseDebugEvents(stderr: string): DebugEvent[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as DebugEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is DebugEvent => e !== null);
}

/* ─── Suite ─────────────────────────────────────────────────────────── */

describe('issue #660 — ko-KR UNUserNotificationCenter permission sheet', () => {
  const gate = shouldRun();

  if (!gate.run) {
    test('suite skipped (opt-in / environment gate)', () => {
      console.warn(`[issue-660] ${gate.reason}`);
      // Use a no-op assertion so the test passes cleanly when skipped.
      expect(true).toBe(true);
    });
    return;
  }

  let toolHandler: (
    sessionId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeAll(() => {
    let captured: typeof toolHandler | undefined;
    const fakeServer = {
      registerTool: (_schema: unknown, handler: unknown) => {
        captured = handler as typeof toolHandler;
      },
    } as unknown as MCPServer;
    registerAppHandleAlertTool(fakeServer);
    if (!captured) throw new Error('app_handle_alert handler was not registered');
    toolHandler = captured;
  });

  test('reset → cold-launch → app_handle_alert dismiss returns ax-scan with 허용 / 허용 안 함', async () => {
    // Once the operator has flipped the opt-in env var, environmental
    // failures are setup errors that the operator alone can resolve and
    // must surface as test failures — silently passing on a degraded
    // environment hides regressions in the verification itself.
    terminateApp();
    const reset = resetNotifications();
    if (!reset.ok) {
      throw new Error(`[issue-660] ${reset.reason}`);
    }

    launchApp();
    // Poll the sheet by re-running the tool: app_handle_alert tolerates the
    // sheet not being up yet and surfaces visibleButtons/visibleStaticTexts
    // diagnostics. We re-call until either visibleButtons contains a known
    // sheet label or the wait budget elapses.
    const deadline = Date.now() + SHEET_WAIT_MS;
    let lastBody: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const result = await toolHandler('issue-660', {
        action: 'dismiss',
        deviceId: DEVICE_ID,
        keyboardFallback: false,
      });
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
      lastBody = body;
      const visibleButtons = ((body.visibleButtons as string[]) ?? []).map(canonicalLabel);
      const sawSheet = visibleButtons.some(
        (label) => label === ACCEPT_LABEL || label === DISMISS_LABEL,
      );
      if (sawSheet) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!lastBody) {
      throw new Error('[issue-660] tool handler returned no body');
    }

    // Compare against canonicalized labels — `app_handle_alert` may surface
    // `"허용 안 함 (norm: 허용 안 함)"` when SpringBoard uses NBSP between
    // syllables, and a strict equality assertion against the raw constant
    // would falsely fail even though the correct button is present.
    const rawVisibleButtons = (lastBody.visibleButtons as string[]) ?? [];
    const visibleButtons = rawVisibleButtons.map(canonicalLabel);
    if (
      !visibleButtons.includes(ACCEPT_LABEL) &&
      !visibleButtons.includes(DISMISS_LABEL)
    ) {
      throw new Error(
        `[issue-660] permission sheet did not appear within ${SHEET_WAIT_MS} ms; ` +
          `visibleButtons=${JSON.stringify(rawVisibleButtons)}.`,
      );
    }

    // Exit criterion 1: dismissed=true via ax-scan
    expect(lastBody.dismissed).toBe(true);
    expect(lastBody.strategy).toBe('ax-scan');

    // Exit criterion 2: visibleButtons contains the localized labels
    expect(visibleButtons).toEqual(
      expect.arrayContaining([ACCEPT_LABEL, DISMISS_LABEL]),
    );
  });

  test('ax-bridge-native dump --debug exits 0 and emits walker_overlay_roles_seen', () => {
    const { exitCode, stderr } = captureDebugStderr();
    // Exit criterion 3: dump exits 0 even with the SpringBoard sheet visible
    // earlier in the suite. This call happens after the dismiss above, so the
    // sheet should already be gone — but the assertion holds either way:
    // a non-zero exit indicates the bridge bailed instead of returning a
    // (possibly partial) tree, which is the failure mode #660 was filed for.
    expect(exitCode).toBe(0);

    const events = parseDebugEvents(stderr);
    const eventNames = events.map((e) => e.event);
    // PR C-prime guarantees these events fire on every --debug invocation:
    expect(eventNames).toEqual(
      expect.arrayContaining([
        'walker_app_windows_enumerated',
        'walker_top_candidates',
        'walker_overlay_roles_seen',
      ]),
    );

    const enumerated = events.find((e) => e.event === 'walker_app_windows_enumerated');
    expect(enumerated).toBeDefined();
    expect(typeof enumerated?.count).toBe('number');
    expect((enumerated?.count as number) >= 1).toBe(true);
  });
});
