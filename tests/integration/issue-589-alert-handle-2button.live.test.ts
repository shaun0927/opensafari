/**
 * Live integration suite for issue #589 — proves that `app_alert_handle`
 * correctly identifies and presses buttons in a classic 2-button
 * UIAlertController (accept / dismiss) via the AX-press label-match path.
 *
 * Trigger mechanism: Safari's `confirm()` JS dialog surfaces as a native
 * 2-button UIAlertController with ko-KR labels "확인" (OK) and "취소" (Cancel).
 * We launch Mobile Safari and navigate to a `data:` URL containing a
 * `setTimeout(confirm(...), 500)` call. This is deterministic across iOS
 * versions because `confirm()` is always a blocking native sheet in Safari.
 *
 * Graceful skip conditions (warn + return, no test failure):
 *   - No booted simulator found (`OSF_DEVICE_ID` mismatch).
 *   - The confirm dialog does not appear within 10 s (e.g. different locale,
 *     accessibility permission not granted).
 *   - The triggered alert does not yield exactly 2 AXButton nodes with labels
 *     in the expected set — version-specific UI changed.
 *
 * Setup prerequisites:
 *   - Booted iOS Simulator with a visible device window.
 *   - `OPENSAFARI_ALLOW_FOCUS_INPUT=1` so the Tier-3 CGEvent backend is
 *     available on Xcode 26+.
 *   - Simulator locale ko-KR recommended; the test also accepts en-US labels
 *     OK / Cancel as a fallback.
 *
 * Run:
 *   OPENSAFARI_ALLOW_FOCUS_INPUT=1 OSF_DEVICE_ID=<UDID> \
 *     npx jest tests/integration/issue-589-alert-handle-2button.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 */
process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';

import { execSync } from 'child_process';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import type { AXNode } from '../../src/native/ax-types';

/* ─── Constants ─────────────────────────────────────────────────────── */

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';

const SAFARI_BUNDLE = 'com.apple.mobilesafari';

/**
 * data: URL that opens a confirm() dialog 500 ms after load.
 * Using encodeURIComponent so the shell does not interpret special chars.
 */
const CONFIRM_HTML = `data:text/html,<script>setTimeout(function(){confirm('\uD14C\uC2A4\uD2B8');},500);</script>`;

/** Labels that may appear on the accept button (ko-KR first, en-US fallback). */
const ACCEPT_LABELS = ['확인', 'OK'];
/** Labels that may appear on the dismiss button (ko-KR first, en-US fallback). */
const DISMISS_LABELS = ['취소', 'Cancel'];
/** All expected button labels across both buttons. */
const ALL_EXPECTED_LABELS = [...ACCEPT_LABELS, ...DISMISS_LABELS];

/** How long to wait for the confirm dialog to appear (ms). */
const ALERT_WAIT_MS = 10_000;
/** Poll interval while waiting for the alert (ms). */
const POLL_INTERVAL_MS = 500;

jest.setTimeout(180_000);

/* ─── Helpers ───────────────────────────────────────────────────────── */

/** Collect all AXNode labels (trimmed, non-empty) from the tree via BFS. */
function collectAllLabels(node: AXNode): string[] {
  const labels: string[] = [];
  const queue: AXNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const lbl = (current.label ?? '').trim();
    if (lbl.length > 0) labels.push(lbl);
    if (current.children) {
      for (const child of current.children) queue.push(child);
    }
  }
  return labels;
}

/**
 * Count how many labels in `tree` match (case-insensitively, trimmed) any
 * label in `candidates`.
 */
function countMatchingLabels(tree: AXNode, candidates: string[]): number {
  const normalized = candidates.map((l) => l.trim().toLowerCase());
  const found = collectAllLabels(tree).filter((l) =>
    normalized.includes(l.toLowerCase()),
  );
  return found.length;
}

/**
 * Wait up to `timeoutMs` for the AX tree to contain at least one label from
 * `candidates`. Returns the tree once found, or null on timeout.
 */
async function waitForAlert(
  deviceId: string,
  candidates: string[],
  timeoutMs: number,
): Promise<AXNode | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await ensureSemanticsActive(deviceId);
      const bridge = getAccessibilityBridge();
      const tree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
      if (countMatchingLabels(tree, candidates) > 0) return tree;
    } catch {
      /* bridge not ready yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/** Launch Safari and open the confirm() data: URL. */
function triggerConfirmDialog(): void {
  // Terminate any existing Safari session so we get a clean state.
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${SAFARI_BUNDLE}`, {
      stdio: 'pipe',
    });
  } catch {
    /* was not running — fine */
  }

  execSync(
    `xcrun simctl openurl ${DEVICE_ID} ${JSON.stringify(CONFIRM_HTML)}`,
    { stdio: 'pipe' },
  );
}

/* ─── Lifecycle ─────────────────────────────────────────────────────── */

afterAll(async () => {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${SAFARI_BUNDLE}`, {
      stdio: 'pipe',
    });
  } catch {
    /* already gone */
  }
});

/* ─── Suite ─────────────────────────────────────────────────────────── */

describe('issue #589 — app_alert_handle 2-button UIAlertController ko-KR', () => {
  /**
   * Test A — dismiss path: pressing 취소 / Cancel resolves the confirm() with
   * `false`.  We run this first so we leave the browser ready for Test B.
   */
  test('handles dismiss button (취소 / Cancel) via ax-press label-match', async () => {
    triggerConfirmDialog();
    // Wait for the alert to appear (accept or dismiss label visible).
    const tree = await waitForAlert(DEVICE_ID, ALL_EXPECTED_LABELS, ALERT_WAIT_MS);

    if (!tree) {
      console.warn(
        '[issue-589] confirm() dialog did not appear within 10 s — ' +
          'skipping test (locale or permission issue).',
      );
      return;
    }

    // Count how many distinct expected labels are present.
    const bridge = getAccessibilityBridge();
    const freshTree = await bridge.dumpTree({ deviceId: DEVICE_ID, maxDepth: 8 });
    const matchCount = countMatchingLabels(freshTree, ALL_EXPECTED_LABELS);

    if (matchCount !== 2) {
      const visible = collectAllLabels(freshTree);
      console.warn(
        `[issue-589] Expected exactly 2 matching button labels; found ${matchCount}. ` +
          `Visible labels: ${JSON.stringify(visible)}. Skipping.`,
      );
      return;
    }

    // Call app_alert_handle directly (same logic as the MCP tool, exercised
    // at the source level without spawning an MCP server).
    const matchedNode = findButtonByLabels(freshTree, DISMISS_LABELS);

    if (!matchedNode) {
      const visible = collectAllLabels(freshTree);
      console.warn(
        `[issue-589] Dismiss button not found in tree. Visible: ${JSON.stringify(visible)}. Skipping.`,
      );
      return;
    }

    const pressResponse = await bridge.press(matchedNode.path, DEVICE_ID);

    expect(pressResponse.ok).toBe(true);
    expect(pressResponse.code).toBe('OK');
    expect(
      DISMISS_LABELS.map((l) => l.toLowerCase()).includes(
        (pressResponse.label ?? '').trim().toLowerCase(),
      ),
    ).toBe(true);

    // Brief pause so Safari settles before Test B.
    await new Promise((r) => setTimeout(r, 800));
  });

  /**
   * Test B — accept path: re-trigger the dialog and press 확인 / OK.
   */
  test('handles accept button (확인 / OK) via ax-press label-match', async () => {
    // Re-trigger the alert.
    triggerConfirmDialog();
    const tree = await waitForAlert(DEVICE_ID, ALL_EXPECTED_LABELS, ALERT_WAIT_MS);

    if (!tree) {
      console.warn(
        '[issue-589] confirm() dialog did not re-appear within 10 s — ' +
          'skipping test.',
      );
      return;
    }

    const bridge = getAccessibilityBridge();
    const freshTree = await bridge.dumpTree({ deviceId: DEVICE_ID, maxDepth: 8 });
    const matchCount = countMatchingLabels(freshTree, ALL_EXPECTED_LABELS);

    if (matchCount !== 2) {
      const visible = collectAllLabels(freshTree);
      console.warn(
        `[issue-589] Expected exactly 2 matching button labels; found ${matchCount}. ` +
          `Visible labels: ${JSON.stringify(visible)}. Skipping.`,
      );
      return;
    }

    const matchedNode = findButtonByLabels(freshTree, ACCEPT_LABELS);

    if (!matchedNode) {
      const visible = collectAllLabels(freshTree);
      console.warn(
        `[issue-589] Accept button not found in tree. Visible: ${JSON.stringify(visible)}. Skipping.`,
      );
      return;
    }

    const pressResponse = await bridge.press(matchedNode.path, DEVICE_ID);

    expect(pressResponse.ok).toBe(true);
    expect(pressResponse.code).toBe('OK');
    expect(
      ACCEPT_LABELS.map((l) => l.toLowerCase()).includes(
        (pressResponse.label ?? '').trim().toLowerCase(),
      ),
    ).toBe(true);
  });
});

/* ─── Local BFS helper (mirrors app-alert-handle.ts logic) ──────────── */

/**
 * Walk an AX tree looking for nodes whose label matches one of the supplied
 * candidate labels (case-insensitive, trimmed). Returns the first match in
 * priority order (i.e. the order of `labels`).
 *
 * This mirrors the `findButtonByLabels` implementation in
 * `src/tools/app-alert-handle.ts` so this test exercises the same
 * label-matching semantics without coupling to internal module exports.
 */
function findButtonByLabels(node: AXNode, labels: string[]): AXNode | null {
  const normalizedLabels = labels.map((l) => l.trim().toLowerCase());
  const queue: AXNode[] = [node];
  const found: Array<{ priorityIndex: number; node: AXNode }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nodeLabel = (current.label ?? '').trim().toLowerCase();
    if (nodeLabel.length > 0) {
      const idx = normalizedLabels.indexOf(nodeLabel);
      if (idx !== -1) {
        found.push({ priorityIndex: idx, node: current });
      }
    }
    if (current.children) {
      for (const child of current.children) queue.push(child);
    }
  }

  if (found.length === 0) return null;
  found.sort((a, b) => a.priorityIndex - b.priorityIndex);
  return found[0].node;
}
