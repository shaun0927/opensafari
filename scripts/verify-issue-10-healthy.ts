/**
 * Verify #10 healthy-path assertions.
 *
 * Runnable via: ts-node scripts/verify-issue-10-healthy.ts
 *
 * Environment variables:
 *   OSF_DEVICE_ID            — target simulator UDID (default: 3BEF4E9A-069A-4419-AC62-AB889348EF12)
 *   OSF_FLUTTER_BUNDLE_ID    — Flutter fixture bundle id (default: com.opensafari.fixtures.flutterQaApp)
 *   OSF_VERIFY_PRIMARY_LABEL — override AXIdentifier/label for primary button (default: verify.button.primary)
 *   OSF_VERIFY_DETAIL_LABEL  — override AXIdentifier/label for detail button (default: verify.button.detail)
 *
 * Exit codes:
 *   0 — all assertions PASS
 *   1 — one or more assertions FAIL, or preflight failed (BLOCKERS_OPEN / missing dependencies)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { execFileSync } from 'child_process';
import { tryGetFlutterVMClient } from '../src/tools/native-input-backend';

// ── Configuration ─────────────────────────────────────────────────────────────

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const FLUTTER_BUNDLE =
  process.env.OSF_FLUTTER_BUNDLE_ID ?? 'com.opensafari.fixtures.flutterQaApp';
const PRIMARY_LABEL =
  process.env.OSF_VERIFY_PRIMARY_LABEL ?? 'verify.button.primary';
const DETAIL_LABEL =
  process.env.OSF_VERIFY_DETAIL_LABEL ?? 'verify.button.detail';

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'sim-hid-bridge');
const AX_BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'ax-bridge');
const REPORT_PATH = path.resolve(__dirname, '.verify-issue-10-healthy.report.json');

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssertionResult {
  assertion: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  rawResponse: unknown;
}

interface AXNode {
  AXIdentifier?: string;
  label?: string;
  frame?: { x: number; y: number; w: number; h: number };
  children?: AXNode[];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function runBridge(args: string[]): unknown {
  const out = execFileSync(BRIDGE_PATH, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim());
}

function runAxDump(): AXNode {
  const out = execFileSync(AX_BRIDGE_PATH, ['dump', '--device', DEVICE_ID, '--max-depth', '10'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim()) as AXNode;
}

function findNode(root: AXNode, label: string): AXNode | null {
  if (root.AXIdentifier === label || root.label === label) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, label);
    if (found) return found;
  }
  return null;
}

function centerOf(node: AXNode): { x: number; y: number } {
  if (!node.frame) throw new Error(`Node "${node.AXIdentifier ?? node.label}" has no frame`);
  return {
    x: Math.round(node.frame.x + node.frame.w / 2),
    y: Math.round(node.frame.y + node.frame.h / 2),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the Flutter app's Dart VM Service to come online by polling
 * `tryGetFlutterVMClient` until it returns a non-null client. Flutter
 * apps need a few seconds to publish the VM Service URL after launch.
 * Copied verbatim from tests/integration/sim-hid-input.live.test.ts:537-553.
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

// ── Preflight checks ──────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
  // 1. Check blocker issues: #4, #6, #34
  const blockerIssues = [4, 6, 34];
  const openBlockers: number[] = [];
  for (const issueNum of blockerIssues) {
    try {
      const out = execFileSync('gh', ['issue', 'view', String(issueNum), '--json', 'state'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(out.trim()) as { state: string };
      if (parsed.state === 'OPEN') {
        openBlockers.push(issueNum);
      }
    } catch (err) {
      console.log(
        `[PREFLIGHT] Warning: could not fetch state of issue #${issueNum}: ${(err as Error).message}`,
      );
      // Treat fetch failure as non-blocking — allow the script to continue
    }
  }

  if (openBlockers.length > 0) {
    console.log('');
    console.log('[PREFLIGHT] BLOCKERS_OPEN — the following upstream issues are still open:');
    for (const n of openBlockers) {
      console.log(`  - Issue #${n} (https://github.com/junghwan-oss/opensafari/issues/${n})`);
    }
    console.log('');
    console.log(
      'The healthy-path classification (TARGET_BUNDLE_CONFIRMED) cannot be reached until',
    );
    console.log(
      '#4, #6, and #34 are closed. Re-run this script after those issues ship.',
    );
    console.log('');
    process.exit(1);
  }

  // 2. Verify fixture is installed
  try {
    const listOut = execFileSync(
      'xcrun',
      ['simctl', 'listapps', DEVICE_ID],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (!listOut.includes(FLUTTER_BUNDLE)) {
      console.log(
        `[PREFLIGHT] Flutter fixture "${FLUTTER_BUNDLE}" is NOT installed on simulator ${DEVICE_ID}.`,
      );
      console.log(
        '  Install it first: xcrun simctl install <udid> <path/to/app.app>',
      );
      process.exit(1);
    }
  } catch (err) {
    console.log(`[PREFLIGHT] Could not list apps on simulator ${DEVICE_ID}: ${(err as Error).message}`);
    process.exit(1);
  }

  // 3. Verify dist binaries exist and are executable
  for (const binPath of [BRIDGE_PATH, AX_BRIDGE_PATH]) {
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
    } catch {
      console.log(`[PREFLIGHT] Binary not found or not executable: ${binPath}`);
      console.log('  Run "npm run build" first.');
      process.exit(1);
    }
  }

  console.log('[PREFLIGHT] All preflight checks passed.');
}

// ── Assertion runner ──────────────────────────────────────────────────────────

const results: AssertionResult[] = [];

async function assert(
  id: string,
  description: string,
  fn: () => Promise<{ ok: boolean; raw: unknown }>,
): Promise<boolean> {
  const t0 = Date.now();
  let status: 'PASS' | 'FAIL' = 'FAIL';
  let rawResponse: unknown = null;
  try {
    const { ok, raw } = await fn();
    rawResponse = raw;
    status = ok ? 'PASS' : 'FAIL';
  } catch (err) {
    rawResponse = { error: (err as Error).message };
    status = 'FAIL';
  }
  const durationMs = Date.now() - t0;
  results.push({ assertion: id, status, durationMs, rawResponse });
  console.log(`[${status}] ${id}: ${description} (${durationMs}ms)`);
  return status === 'PASS';
}

// ── Assertions H1–H6 ──────────────────────────────────────────────────────────

async function runAssertions(): Promise<void> {
  // Launch the fixture app and wait for Flutter VM
  console.log('\n[SETUP] Launching fixture app...');
  try {
    execFileSync('xcrun', ['simctl', 'terminate', DEVICE_ID, FLUTTER_BUNDLE], {
      stdio: 'pipe',
    });
  } catch {
    // not running — fine
  }
  execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, FLUTTER_BUNDLE], {
    stdio: 'pipe',
  });
  await delay(3000);
  console.log('[SETUP] Waiting for Flutter VM...');
  await waitForFlutterVM();
  console.log('[SETUP] Flutter VM ready.\n');

  // H1 — Context baseline
  await assert('H1', 'context baseline: TARGET_BUNDLE_CONFIRMED after launch', async () => {
    const raw = runBridge(['context', DEVICE_ID, '--expect-bundle', FLUTTER_BUNDLE]);
    const r = raw as Record<string, unknown>;
    const ok =
      r['classification'] === 'TARGET_BUNDLE_CONFIRMED' &&
      r['verified'] === true &&
      r['expectedBundleMatched'] === true &&
      (r['frontmost'] as Record<string, unknown>)?.['bundleId'] === FLUTTER_BUNDLE;
    return { ok, raw };
  });

  // Discover primary button coordinates
  let primaryCenter: { x: number; y: number } | null = null;
  try {
    const tree = runAxDump();
    const primaryNode = findNode(tree as AXNode, PRIMARY_LABEL);
    if (primaryNode) primaryCenter = centerOf(primaryNode);
  } catch (err) {
    console.log(`[WARN] ax-bridge dump failed for primary button: ${(err as Error).message}`);
  }

  // Capture pre-tap visibleSummary BEFORE H2 so H4 can assert a real
  // navigation advance (detail button absent before, present after).
  let preTapSummary: unknown = null;
  try {
    const ctxBefore = runBridge(['context', DEVICE_ID, '--expect-bundle', FLUTTER_BUNDLE]);
    preTapSummary = (ctxBefore as Record<string, unknown>)['visibleSummary'];
  } catch {
    // H4 will record the miss if this fails.
  }

  // H2 — Healthy tap
  await assert('H2', 'healthy tap on verify.button.primary: ok+verified+TARGET_BUNDLE_CONFIRMED', async () => {
    if (!primaryCenter) throw new Error(`Could not locate node "${PRIMARY_LABEL}" via ax-bridge`);
    const raw = runBridge([
      'tap', DEVICE_ID,
      String(primaryCenter.x), String(primaryCenter.y),
      '--expect-bundle', FLUTTER_BUNDLE,
    ]);
    const r = raw as Record<string, unknown>;
    const ok =
      r['ok'] === true &&
      r['dispatch'] === 'ok' &&
      r['verified'] === true &&
      r['classification'] === 'TARGET_BUNDLE_CONFIRMED';
    return { ok, raw };
  });

  await delay(500);

  await assert('H4', 'navigation advance: detail button visible after H2 tap', async () => {
    const ctxAfter = runBridge(['context', DEVICE_ID, '--expect-bundle', FLUTTER_BUNDLE]);
    const summary = (ctxAfter as Record<string, unknown>)['visibleSummary'] as Record<string, unknown>;
    const buttonLabels: string[] = (summary?.['buttonLabels'] as string[]) ?? [];
    const preTapLabels: string[] =
      ((preTapSummary as Record<string, unknown>)?.['buttonLabels'] as string[]) ?? [];
    const ok =
      buttonLabels.some((l) => l.includes(DETAIL_LABEL)) &&
      !preTapLabels.some((l) => l.includes(DETAIL_LABEL));
    return { ok, raw: { preTapLabels, postTapLabels: buttonLabels } };
  });

  // H3 — Healthy swipe (need screen dimensions; use a standard swipe)
  await assert('H3', 'healthy vertical swipe: TARGET_BUNDLE_CONFIRMED', async () => {
    // Use a mid-screen swipe — down from 70% to 30% of a standard 390×844 viewport
    const raw = runBridge([
      'swipe', DEVICE_ID,
      '195', '591',  // startX=screenWidth/2, startY=screenHeight*0.7
      '195', '253',  // endX=screenWidth/2, endY=screenHeight*0.3
      '--expect-bundle', FLUTTER_BUNDLE,
    ]);
    const r = raw as Record<string, unknown>;
    const ok =
      r['classification'] === 'TARGET_BUNDLE_CONFIRMED' &&
      r['verified'] === true;
    return { ok, raw };
  });

  // H5 — 5× sequential healthy taps (primary → detail → primary → detail → primary)
  await assert('H5', '5x sequential taps all return TARGET_BUNDLE_CONFIRMED', async () => {
    const tapResults: unknown[] = [];
    const labels = [PRIMARY_LABEL, DETAIL_LABEL, PRIMARY_LABEL, DETAIL_LABEL, PRIMARY_LABEL];
    let allHealthy = true;

    for (const targetLabel of labels) {
      await delay(300);
      // Re-discover the button each iteration (navigation changes the tree)
      let center: { x: number; y: number } | null = null;
      try {
        const tree = runAxDump();
        const node = findNode(tree as AXNode, targetLabel);
        if (node) center = centerOf(node);
      } catch {
        // fall through
      }

      if (!center) {
        // Use last known primary center as fallback
        center = primaryCenter ?? { x: 195, y: 422 };
      }

      const raw = runBridge([
        'tap', DEVICE_ID,
        String(center.x), String(center.y),
        '--expect-bundle', FLUTTER_BUNDLE,
      ]);
      const r = raw as Record<string, unknown>;
      tapResults.push(raw);

      const healthy =
        r['classification'] === 'TARGET_BUNDLE_CONFIRMED' &&
        r['classification'] !== 'SIMULATOR_CHROME_FOREGROUND' &&
        r['classification'] !== 'FOREGROUND_CONTEXT_UNAVAILABLE';
      if (!healthy) allHealthy = false;
    }

    return { ok: allHealthy, raw: tapResults };
  });

  // H6 — Degraded signal still fires after bringing Safari to foreground
  await assert('H6', 'degraded signal fires when wrong app is foreground', async () => {
    execFileSync('xcrun', ['simctl', 'launch', DEVICE_ID, 'com.apple.mobilesafari'], {
      stdio: 'pipe',
    });
    await delay(1500);
    const raw = runBridge([
      'context', DEVICE_ID,
      '--expect-bundle', FLUTTER_BUNDLE,
      '--require-match', 'true',
    ]);
    const r = raw as Record<string, unknown>;
    const ok = r['ok'] === false && r['code'] === 'EXPECTED_BUNDLE_MISMATCH';
    return { ok, raw };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== verify-issue-10-healthy ===');
  console.log(`Device:  ${DEVICE_ID}`);
  console.log(`Bundle:  ${FLUTTER_BUNDLE}`);
  console.log('');

  await preflight();
  await runAssertions();

  // Write report
  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nReport written to: ${REPORT_PATH}`);

  // Summary
  const allPass = results.every((r) => r.status === 'PASS');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log('');
  console.log(`=== ${allPass ? 'ALL PASS' : 'SOME FAILED'} (${passCount}/${results.length}) ===`);

  process.exit(allPass ? 0 : 1);
}

main().catch((err: Error) => {
  console.log(`[FATAL] ${err.message}`);
  process.exit(1);
});
