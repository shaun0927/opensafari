import { MCPServer } from '../mcp-server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveDeviceId } from './native-app-helpers';
import {
  getAccessibilityBridge,
  getAccessibilityBridgeErrorDiagnostics,
  type AxErrorDiagnostics,
} from '../native/accessibility-bridge';
import type { AXNode } from '../native/ax-types';
import {
  findAlertCandidates,
  collectVisibleButtonLabels,
  collectVisibleStaticTexts,
  type AlertCandidate,
} from './alert-detection';
import {
  ACCEPT_LABELS,
  DISMISS_LABELS,
  flattenLabels,
  type AlertAction,
} from './app-handle-alert-labels';
import type { AlertReason } from '../errors/alert-reasons';
import { inferServices, type PermissionService } from './alert-service-hints';
import { dumpTreeWithRetry } from './app-tree';

const execFileAsync = promisify(execFile);

const VALID_ACTIONS = ['accept', 'dismiss'] as const;
const DEFAULT_DEVICE_WIDTH = 393;
const AX_POLL_TIMEOUT_MS = 3000;
const AX_POLL_INTERVAL_MS = 250;
const DEFAULT_STACKED_WINDOW_MS = 1500;
const DEFAULT_MAX_STACKED_ALERTS = 5;
const AX_RECOVER_TIMEOUT_MS = 1500;

/**
 * Lightweight projection of an `AlertCandidate` returned in
 * `remainingCandidates` so callers can see what alert(s) remain after the
 * dismissal loop without exposing the full AXNode shape.
 */
interface AlertSummary {
  label?: string;
  role?: string;
  axPath?: string;
}

type Strategy =
  | 'ax-scan'
  | 'applescript-sheet'
  | 'keyboard-fallback'
  | 'permission-reset'
  | 'none';
type Surface = 'simulator_chrome' | 'system_dialog_unknown' | 'app_content';
type FallbackMode = 'permission_reset' | 'none';

const VALID_FALLBACKS: FallbackMode[] = ['permission_reset', 'none'];

/**
 * simctl maps some public-facing permission service names differently.
 * Accept the caller-facing names from PermissionService and return the
 * exact service string understood by `xcrun simctl privacy ... reset`.
 */
const SIMCTL_SERVICE_MAP: Record<PermissionService, string> = {
  location: 'location',
  photos: 'photos',
  contacts: 'contacts',
  notifications: 'notifications',
  tracking: 'userTracking',
  camera: 'camera',
  microphone: 'microphone',
  bluetooth: 'bluetooth',
  calendars: 'calendar',
  reminders: 'reminders',
};

interface PermissionResetResult {
  service: PermissionService | null;
  servicesConsidered: PermissionService[];
  executed: boolean;
  dryRun: boolean;
  command?: string;
  error?: string;
}

interface HandleAlertResponse {
  action: AlertAction;
  deviceId: string;
  dismissed: boolean;
  strategy: Strategy;
  strategy_attempted: Strategy[];
  matchedButton?: string;
  reason: AlertReason;
  surface: Surface;
  visibleButtons: string[];
  visibleStaticTexts: string[];
  suggestedLabelsToAdd: string[];
  fallbackAvailable: string[];
  permissionReset?: PermissionResetResult;
  handledAt: string;
  elapsedMs: number;
  /**
   * Number of alert candidates dismissed during this call. Always >= 0.
   * When `dismissAllVisible: false` (default) this is 0 or 1.
   * Optional in the internal builder; the `finalize()` helper guarantees
   * it is always serialized into the JSON response.
   */
  dismissedCount?: number;
  /**
   * Alert candidates still visible after the dismissal loop. Empty when
   * the surface is fully clear or when no candidate was ever detected.
   */
  remainingCandidates?: AlertSummary[];
  /**
   * `true` when the foreground app's AX root re-populated within
   * `AX_RECOVER_TIMEOUT_MS` after the dismissal attempt; `false`
   * otherwise. Always present in the JSON response.
   */
  axRecovered?: boolean;
  axBridgeCode?: string;
  axTopology?: AxErrorDiagnostics['axTopology'];
}

function summarizeCandidate(c: AlertCandidate): AlertSummary {
  const summary: AlertSummary = {};
  if (typeof c.label === 'string' && c.label.length > 0) summary.label = c.label;
  if (typeof c.node.role === 'string' && c.node.role.length > 0) summary.role = c.node.role;
  if (typeof c.node.path === 'string' && c.node.path.length > 0) summary.axPath = c.node.path;
  return summary;
}

/**
 * Build an AppleScript that clicks a Simulator alert button, trying every
 * label in the en/ko/ja/zh-Hans corpus for the requested action before
 * giving up.
 *
 * For any multi-word label, also try a variant that replaces each ASCII
 * space with U+00A0 (NBSP). iOS 26.4's SpringBoard embeds NBSP between
 * syllables of localized labels (e.g. `허용 안 함`) so that
 * System Events' button-by-name match requires the NBSP form.
 */
export function buildAlertScript(action: AlertAction): string {
  const labels = [
    ...flattenLabels(action),
    ...(action === 'accept' ? ['Allow', 'OK', 'Allow While Using App'] : ["Don't Allow", 'Cancel']),
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const l of labels) {
    const k = l.trim();
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    unique.push(k);
    if (k.includes(' ')) {
      const nbspVariant = k.replace(/ /g, ' ');
      if (!seen.has(nbspVariant)) {
        seen.add(nbspVariant);
        unique.push(nbspVariant);
      }
    }
  }
  const tries = unique.map((l) =>
    `      try\n        click button "${escapeAppleScript(l)}" of sheet 1 of window 1\n        return\n      end try`,
  );
  return `
tell application "Simulator" to activate
delay 0.3
tell application "System Events"
  tell process "Simulator"
${tries.join('\n')}
    error "No alert button found"
  end tell
end tell
`;
}

function escapeAppleScript(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function inferSurface(tree: AXNode): Surface {
  let foundDialog = false;
  let foundApp = false;
  const stack: AXNode[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.role === 'AXSheet' || n.role === 'AXDialog') foundDialog = true;
    if (
      n.role === 'AXApplication' &&
      (n.label ?? '').length > 0 &&
      !/Simulator|SpringBoard/.test(n.label ?? '')
    ) {
      foundApp = true;
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  if (foundDialog) return 'system_dialog_unknown';
  if (foundApp) return 'app_content';
  return 'simulator_chrome';
}

/**
 * `collectVisibleButtonLabels` annotates non-ASCII whitespace as
 * `"<original> (norm: <normalized>)"` for diagnostics (slice 2 of #642).
 * `suggestLabels` operates against the raw label corpus and must strip
 * that display-only annotation before matching — otherwise the corpus
 * membership test always misses and we emit synthetic "add me" entries
 * like `"허용 안 함 (norm: 허용 안 함)"`, which are not real button labels
 * and would never match at runtime.
 */
const DIAGNOSTIC_ANNOTATION_SUFFIX = / \(norm: [^)]*\)$/;

function stripDiagnosticAnnotation(label: string): string {
  return label.replace(DIAGNOSTIC_ANNOTATION_SUFFIX, '');
}

function suggestLabels(visibleButtons: string[], action: AlertAction): string[] {
  const corpus = new Set(flattenLabels(action).map((s) => s.trim().toLowerCase()));
  const out: string[] = [];
  for (const label of visibleButtons) {
    const raw = stripDiagnosticAnnotation(label).trim();
    if (raw.length === 0) continue;
    const key = raw.toLowerCase();
    if (!corpus.has(key)) out.push(raw);
  }
  return Array.from(new Set(out));
}

function errorToString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function tryAxScan(
  action: AlertAction,
  deviceId: string,
): Promise<
  | { candidate: AlertCandidate; tree: AXNode }
  | {
      error: 'ax_scan_timeout' | 'no_candidate_button';
      tree: AXNode | null;
      diagnostics?: AxErrorDiagnostics;
    }
> {
  const bridge = getAccessibilityBridge();
  let tree: AXNode;
  try {
    tree = await bridge.dumpTree({ deviceId });
  } catch (err) {
    return {
      error: 'ax_scan_timeout',
      tree: null,
      diagnostics: getAccessibilityBridgeErrorDiagnostics(err),
    };
  }

  const deviceWidth =
    tree.frame && tree.frame.width > 0 ? tree.frame.width : DEFAULT_DEVICE_WIDTH;
  const candidates = findAlertCandidates(action, { tree, deviceWidth });
  if (candidates.length === 0) {
    return { error: 'no_candidate_button', tree };
  }

  const candidate = candidates[0];
  try {
    const press = await bridge.press(candidate.node.path, deviceId);
    if (!press.ok) {
      return { error: 'no_candidate_button', tree };
    }
  } catch (err) {
    return {
      error: 'no_candidate_button',
      tree,
      diagnostics: getAccessibilityBridgeErrorDiagnostics(err),
    };
  }

  return { candidate, tree };
}

async function pollForDismissal(
  action: AlertAction,
  deviceId: string,
  previousCandidatePath: string,
): Promise<boolean> {
  const bridge = getAccessibilityBridge();
  const deadline = Date.now() + AX_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tree = await bridge.dumpTree({ deviceId });
      const deviceWidth =
        tree.frame && tree.frame.width > 0 ? tree.frame.width : DEFAULT_DEVICE_WIDTH;
      const stillThere = findAlertCandidates(action, { tree, deviceWidth }).some(
        (c) => c.node.path === previousCandidatePath,
      );
      if (!stillThere) return true;
    } catch {
      // swallow and retry
    }
    await sleep(AX_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * After a successful dismissal, re-scan the AX tree once and dismiss any
 * additional alert candidate of the same `action` that appears within
 * `windowMs`. Returns the number of *additional* dismissals beyond the
 * caller's first one, plus the most recent tree observed (so the parent
 * handler can populate diagnostics) and any candidates still visible.
 *
 * Caps iteration at `maxIterations` to bound worst-case latency on
 * misbehaving stacks. Each successful press is followed by `pollForDismissal`
 * to let the surface settle before re-scanning.
 */
async function dismissStackedAlerts(
  action: AlertAction,
  deviceId: string,
  windowMs: number,
  maxIterations: number,
): Promise<{ extraDismissed: number; lastTree: AXNode | null; remaining: AlertCandidate[] }> {
  const bridge = getAccessibilityBridge();
  let extraDismissed = 0;
  let lastTree: AXNode | null = null;
  let remaining: AlertCandidate[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const deadline = Date.now() + windowMs;
    let candidate: AlertCandidate | null = null;
    while (Date.now() < deadline) {
      try {
        const tree = await bridge.dumpTree({ deviceId });
        lastTree = tree;
        const deviceWidth =
          tree.frame && tree.frame.width > 0 ? tree.frame.width : DEFAULT_DEVICE_WIDTH;
        const next = findAlertCandidates(action, { tree, deviceWidth });
        if (next.length > 0) {
          candidate = next[0];
          remaining = next;
          break;
        }
        remaining = [];
      } catch {
        // swallow; retry until deadline
      }
      await sleep(AX_POLL_INTERVAL_MS);
    }
    if (!candidate) return { extraDismissed, lastTree, remaining: [] };

    try {
      const press = await bridge.press(candidate.node.path, deviceId);
      if (!press.ok) return { extraDismissed, lastTree, remaining };
    } catch {
      return { extraDismissed, lastTree, remaining };
    }

    // Codex P1 review on PR #682: only count the dismissal if
    // `pollForDismissal` confirms the alert disappeared. If the press
    // returned ok but the surface never settled (AX state unchanged
    // until the poll deadline), counting it would over-report
    // `dismissedCount` AND the next iteration would re-find and re-press
    // the same candidate up to `maxIterations`. Bail out instead and
    // keep the candidate in `remaining` so the diagnostics block
    // surfaces it to the caller.
    const dismissed = await pollForDismissal(action, deviceId, candidate.node.path);
    if (!dismissed) {
      return { extraDismissed, lastTree, remaining };
    }
    extraDismissed += 1;
  }

  // Final scan to report any candidates left after the cap.
  try {
    const tree = await bridge.dumpTree({ deviceId });
    lastTree = tree;
    const deviceWidth =
      tree.frame && tree.frame.width > 0 ? tree.frame.width : DEFAULT_DEVICE_WIDTH;
    remaining = findAlertCandidates(action, { tree, deviceWidth });
  } catch {
    // best-effort; keep last known `remaining`
  }
  return { extraDismissed, lastTree, remaining };
}

/**
 * Best-effort probe that the foreground app's AX root has re-populated
 * after a dismissal. Returns `true` when the resulting tree has at
 * least one child node within `AX_RECOVER_TIMEOUT_MS`.
 *
 * Codex P2 review on PR #682: the helper previously called
 * `dumpTreeWithRetry` with its **default** retry budget, which adds an
 * internal `250 + 500 + 1000 = 1750 ms` backoff before re-throwing on
 * persistent empty-root. That single call could exceed the
 * `AX_RECOVER_TIMEOUT_MS` budget on its own, so a confirmed dismissal
 * could block the caller longer than advertised.
 *
 * We now drive the retry loop ourselves: each attempt is a `maxRetries
 * = 0` invocation of `dumpTreeWithRetry` (single shot, no internal
 * backoff) and the empty-root error simply triggers our own sleep
 * (`AX_POLL_INTERVAL_MS`) before the next attempt. The deadline check
 * runs both before and after each `await sleep` so the total wall time
 * is strictly bounded by `AX_RECOVER_TIMEOUT_MS` regardless of how
 * many empty-root retries iOS forces.
 */
async function probeAxRecovered(deviceId: string): Promise<boolean> {
  const bridge = getAccessibilityBridge();
  const deadline = Date.now() + AX_RECOVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // `maxRetries = 0` keeps the single-shot semantic — no
      // dumpTreeWithRetry-internal backoff. The empty-root case is
      // re-thrown immediately and caught below so our own loop drives
      // the retry cadence within the declared budget.
      const tree = (await dumpTreeWithRetry(bridge, { deviceId }, 0)) as AXNode;
      const childCount = Array.isArray(tree?.children) ? tree.children.length : 0;
      if (childCount > 0) return true;
    } catch {
      // empty-root or any other dump failure — retry until budget exhausted
    }
    if (Date.now() >= deadline) break;
    await sleep(AX_POLL_INTERVAL_MS);
  }
  return false;
}

async function tryAppleScript(action: AlertAction): Promise<boolean> {
  const script = buildAlertScript(action);
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tier 2.5 — OS-level keyboard fallback.
 *
 * When AX enumeration (Tier 1) returns an empty tree (e.g. iOS 26.4
 * UNUserNotificationCenter permission sheets on ko-KR simulators) AND the
 * AppleScript `click button` matcher (Tier 2) can't match any localized
 * label, we still know the *intent* — accept vs dismiss — so sending the
 * default OS-dialog keystroke is a safe last-resort recovery path:
 *
 *   accept  → Return   (activates the default button)
 *   dismiss → Escape   (dismisses the dialog)
 *
 * We route the keystroke through the Simulator's frontmost process so it
 * reaches the iOS guest dialog. This never displaces focus from a user-
 * focused app because `tell application "Simulator" to activate` runs
 * only after both higher tiers have already tried and missed.
 */
export function buildKeyboardFallbackScript(action: AlertAction): string {
  // key code 36 = Return, key code 53 = Escape
  const keyAction = action === 'accept' ? 'key code 36' : 'key code 53';
  return `
tell application "Simulator" to activate
delay 0.2
tell application "System Events"
  tell process "Simulator"
    ${keyAction}
  end tell
end tell
`;
}

async function tryKeyboardFallback(action: AlertAction): Promise<boolean> {
  const script = buildKeyboardFallbackScript(action);
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

export function registerAppHandleAlertTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_handle_alert',
      description:
        'Handle system alert dialogs in the iOS Simulator (e.g. permission prompts). Accepts or dismisses the currently visible alert using an AX-scan detector (locale-aware for en/ko/ja/zh-Hans), then an AppleScript label-match fallback, then an OS-level keyboard fallback (Return for accept, Escape for dismiss). Returns rich diagnostics (visibleButtons, visibleStaticTexts, suggestedLabelsToAdd) when no candidate is found.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['accept', 'dismiss'],
            description: 'Accept or dismiss the alert',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          fallback: {
            type: 'string',
            enum: ['permission_reset', 'none'],
            description:
              'When Tier 1 (AX-scan), Tier 2 (AppleScript) and Tier 2.5 (keyboard) all miss the dialog, optionally run `xcrun simctl privacy <udid> reset <service>` with a service inferred from visibleStaticTexts. Default "none".',
          },
          dryRun: {
            type: 'boolean',
            description:
              'When fallback="permission_reset", do not actually execute simctl — report the command that would run. Default false.',
          },
          keyboardFallback: {
            type: 'boolean',
            description:
              'When Tier 1 (AX-scan) and Tier 2 (AppleScript label match) both miss the dialog, send an OS-level keystroke (Return for accept, Escape for dismiss) as a Tier 2.5 recovery. Safe for system dialogs where intent is unambiguous. Default true.',
          },
          dismissAllVisible: {
            type: 'boolean',
            description:
              'After the first successful dismissal, keep re-scanning for stacked alerts of the same `action` and dismiss them until no candidate appears within `stackedAlertWindowMs` or `maxStackedAlerts` is reached. Default false (single-dismissal behavior).',
          },
          stackedAlertWindowMs: {
            type: 'number',
            description: `Per-iteration window (ms) the stacked-dismissal loop waits for the next candidate to appear. Default ${DEFAULT_STACKED_WINDOW_MS}.`,
          },
          maxStackedAlerts: {
            type: 'number',
            description: `Hard cap on stacked dismissals after the first one. Default ${DEFAULT_MAX_STACKED_ALERTS}.`,
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const started = Date.now();
      const action = params.action as AlertAction;

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: invalid action "${String(params.action)}". Must be one of: ${VALID_ACTIONS.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorToString(err)}` }],
          isError: true,
        };
      }

      const fallbackRaw = params.fallback;
      const fallback: FallbackMode =
        typeof fallbackRaw === 'string' && (VALID_FALLBACKS as string[]).includes(fallbackRaw)
          ? (fallbackRaw as FallbackMode)
          : 'none';
      const dryRun = params.dryRun === true;
      const keyboardFallback = params.keyboardFallback !== false;
      const dismissAllVisible = params.dismissAllVisible === true;
      const stackedAlertWindowMs =
        typeof params.stackedAlertWindowMs === 'number' && params.stackedAlertWindowMs > 0
          ? params.stackedAlertWindowMs
          : DEFAULT_STACKED_WINDOW_MS;
      const maxStackedAlerts =
        typeof params.maxStackedAlerts === 'number' && params.maxStackedAlerts > 0
          ? Math.floor(params.maxStackedAlerts)
          : DEFAULT_MAX_STACKED_ALERTS;

      const strategyAttempted: Strategy[] = [];
      let finalTree: AXNode | null = null;
      let dismissedCount = 0;
      let remainingCandidates: AlertSummary[] = [];
      let axDiagnostics: AxErrorDiagnostics = {};

      const finalize = async (
        body: HandleAlertResponse,
        opts: { didDismiss: boolean },
      ) => {
        body.dismissedCount = dismissedCount;
        body.remainingCandidates = remainingCandidates;
        Object.assign(body, axDiagnostics);
        // Only probe AX recovery when we actually dismissed something.
        // A diagnostics-only response (no dismissal attempted) leaves
        // `axRecovered: false` since there is nothing to recover from.
        body.axRecovered = opts.didDismiss ? await probeAxRecovered(deviceId) : false;
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      };

      // Tier 1: AX-scan
      strategyAttempted.push('ax-scan');
      const axResult = await tryAxScan(action, deviceId);
      if ('diagnostics' in axResult && axResult.diagnostics) {
        axDiagnostics = axResult.diagnostics;
      }

      if ('candidate' in axResult) {
        finalTree = axResult.tree;
        const dismissed = await pollForDismissal(action, deviceId, axResult.candidate.node.path);
        if (dismissed) dismissedCount = 1;

        if (dismissed && dismissAllVisible) {
          const stack = await dismissStackedAlerts(
            action,
            deviceId,
            stackedAlertWindowMs,
            maxStackedAlerts,
          );
          dismissedCount += stack.extraDismissed;
          if (stack.lastTree) finalTree = stack.lastTree;
          remainingCandidates = stack.remaining.map(summarizeCandidate);
        }

        const treeForDiagnostics = finalTree ?? axResult.tree;
        const visibleButtons = collectVisibleButtonLabels(treeForDiagnostics);
        const visibleStaticTexts = collectVisibleStaticTexts(treeForDiagnostics);

        const body: HandleAlertResponse = {
          action,
          deviceId,
          dismissed,
          strategy: 'ax-scan',
          strategy_attempted: strategyAttempted,
          matchedButton: axResult.candidate.label,
          reason: dismissed ? 'ok' : 'ax_scan_timeout',
          surface: dismissed ? 'app_content' : inferSurface(axResult.tree),
          visibleButtons,
          visibleStaticTexts,
          suggestedLabelsToAdd: [],
          fallbackAvailable: dismissed ? [] : ['permission_reset', 'simulator_reboot'],
          handledAt: isoNow(),
          elapsedMs: Date.now() - started,
        };
        return finalize(body, { didDismiss: dismissed });
      }

      if (axResult.tree) finalTree = axResult.tree;

      // Tier 2: AppleScript fallback
      strategyAttempted.push('applescript-sheet');
      const applescriptOk = await tryAppleScript(action);

      if (applescriptOk) {
        dismissedCount = 1;
        if (dismissAllVisible) {
          const stack = await dismissStackedAlerts(
            action,
            deviceId,
            stackedAlertWindowMs,
            maxStackedAlerts,
          );
          dismissedCount += stack.extraDismissed;
          if (stack.lastTree) finalTree = stack.lastTree;
          remainingCandidates = stack.remaining.map(summarizeCandidate);
        }
        const visibleButtons = finalTree ? collectVisibleButtonLabels(finalTree) : [];
        const visibleStaticTexts = finalTree ? collectVisibleStaticTexts(finalTree) : [];
        const body: HandleAlertResponse = {
          action,
          deviceId,
          dismissed: true,
          strategy: 'applescript-sheet',
          strategy_attempted: strategyAttempted,
          reason: 'ok',
          surface: 'app_content',
          visibleButtons,
          visibleStaticTexts,
          suggestedLabelsToAdd: [],
          fallbackAvailable: [],
          handledAt: isoNow(),
          elapsedMs: Date.now() - started,
        };
        return finalize(body, { didDismiss: true });
      }

      // Tier 2.5: OS-level keyboard fallback. Intent (accept/dismiss) is
      // unambiguous, so when AX and AppleScript label matching both miss we
      // send Return (accept) or Escape (dismiss) as a last-resort recovery.
      // Disabled when the caller explicitly sets keyboardFallback: false.
      if (keyboardFallback) {
        strategyAttempted.push('keyboard-fallback');
        const keyboardOk = await tryKeyboardFallback(action);
        if (keyboardOk) {
          dismissedCount = 1;
          if (dismissAllVisible) {
            const stack = await dismissStackedAlerts(
              action,
              deviceId,
              stackedAlertWindowMs,
              maxStackedAlerts,
            );
            dismissedCount += stack.extraDismissed;
            if (stack.lastTree) finalTree = stack.lastTree;
            remainingCandidates = stack.remaining.map(summarizeCandidate);
          }
          const visibleButtons = finalTree ? collectVisibleButtonLabels(finalTree) : [];
          const visibleStaticTexts = finalTree ? collectVisibleStaticTexts(finalTree) : [];
          const suggestedLabelsToAdd = suggestLabels(visibleButtons, action);
          const body: HandleAlertResponse = {
            action,
            deviceId,
            dismissed: true,
            strategy: 'keyboard-fallback',
            strategy_attempted: strategyAttempted,
            reason: 'ok',
            surface: 'app_content',
            visibleButtons,
            visibleStaticTexts,
            suggestedLabelsToAdd,
            fallbackAvailable: [],
            handledAt: isoNow(),
            elapsedMs: Date.now() - started,
          };
          return finalize(body, { didDismiss: true });
        }
      }

      // All detection tiers failed — gather diagnostics.
      const visibleButtons = finalTree ? collectVisibleButtonLabels(finalTree) : [];
      const visibleStaticTexts = finalTree ? collectVisibleStaticTexts(finalTree) : [];
      const suggestedLabelsToAdd = suggestLabels(visibleButtons, action);
      const surface: Surface = finalTree ? inferSurface(finalTree) : 'simulator_chrome';

      // Tier 3: permission_reset fallback (opt-in).
      if (fallback === 'permission_reset') {
        strategyAttempted.push('permission-reset');
        const services = inferServices(visibleStaticTexts);

        if (services.length === 0) {
          const body: HandleAlertResponse = {
            action,
            deviceId,
            dismissed: false,
            strategy: 'none',
            strategy_attempted: strategyAttempted,
            reason: 'permission_reset_unknown_service',
            surface,
            visibleButtons,
            visibleStaticTexts,
            suggestedLabelsToAdd,
            fallbackAvailable: ['simulator_reboot'],
            permissionReset: {
              service: null,
              servicesConsidered: [],
              executed: false,
              dryRun,
            },
            handledAt: isoNow(),
            elapsedMs: Date.now() - started,
          };
          return finalize(body, { didDismiss: false });
        }

        if (services.length >= 2) {
          const body: HandleAlertResponse = {
            action,
            deviceId,
            dismissed: false,
            strategy: 'none',
            strategy_attempted: strategyAttempted,
            reason: 'permission_reset_ambiguous',
            surface,
            visibleButtons,
            visibleStaticTexts,
            suggestedLabelsToAdd,
            fallbackAvailable: ['simulator_reboot'],
            permissionReset: {
              service: null,
              servicesConsidered: services,
              executed: false,
              dryRun,
            },
            handledAt: isoNow(),
            elapsedMs: Date.now() - started,
          };
          return finalize(body, { didDismiss: false });
        }

        const service = services[0];
        const simctlService = SIMCTL_SERVICE_MAP[service];
        const command = `xcrun simctl privacy ${deviceId} reset ${simctlService}`;

        if (dryRun) {
          const body: HandleAlertResponse = {
            action,
            deviceId,
            dismissed: false,
            strategy: 'permission-reset',
            strategy_attempted: strategyAttempted,
            reason: 'ok',
            surface,
            visibleButtons,
            visibleStaticTexts,
            suggestedLabelsToAdd,
            fallbackAvailable: [],
            permissionReset: {
              service,
              servicesConsidered: services,
              executed: false,
              dryRun: true,
              command,
            },
            handledAt: isoNow(),
            elapsedMs: Date.now() - started,
          };
          return finalize(body, { didDismiss: false });
        }

        try {
          await execFileAsync(
            'xcrun',
            ['simctl', 'privacy', deviceId, 'reset', simctlService],
            { timeout: 10_000 },
          );
        } catch (err) {
          const body: HandleAlertResponse = {
            action,
            deviceId,
            dismissed: false,
            strategy: 'none',
            strategy_attempted: strategyAttempted,
            reason: 'no_candidate_button',
            surface,
            visibleButtons,
            visibleStaticTexts,
            suggestedLabelsToAdd,
            fallbackAvailable: ['simulator_reboot'],
            permissionReset: {
              service,
              servicesConsidered: services,
              executed: false,
              dryRun: false,
              command,
              error: errorToString(err),
            },
            handledAt: isoNow(),
            elapsedMs: Date.now() - started,
          };
          return finalize(body, { didDismiss: false });
        }

        const body: HandleAlertResponse = {
          action,
          deviceId,
          dismissed: true,
          strategy: 'permission-reset',
          strategy_attempted: strategyAttempted,
          reason: 'ok',
          surface: 'app_content',
          visibleButtons,
          visibleStaticTexts,
          suggestedLabelsToAdd,
          fallbackAvailable: [],
          permissionReset: {
            service,
            servicesConsidered: services,
            executed: true,
            dryRun: false,
            command,
          },
          handledAt: isoNow(),
          elapsedMs: Date.now() - started,
        };
        // permission-reset cleared the prompt, count it as a dismissal so
        // we attempt AX recovery before returning.
        dismissedCount = Math.max(dismissedCount, 1);
        return finalize(body, { didDismiss: true });
      }

      // Fallback disabled — emit diagnostics-only response.
      const reason: AlertReason =
        axResult.error === 'ax_scan_timeout' && !finalTree
          ? 'ax_scan_timeout'
          : 'no_candidate_button';

      const body: HandleAlertResponse = {
        action,
        deviceId,
        dismissed: false,
        strategy: 'none',
        strategy_attempted: strategyAttempted,
        reason,
        surface,
        visibleButtons,
        visibleStaticTexts,
        suggestedLabelsToAdd,
        fallbackAvailable: ['permission_reset', 'simulator_reboot'],
        handledAt: isoNow(),
        elapsedMs: Date.now() - started,
      };

      return finalize(body, { didDismiss: false });
    },
  );
}

/** @internal — exposed for tests only. */
export const _internal = {
  buildAlertScript,
  buildKeyboardFallbackScript,
  inferSurface,
  suggestLabels,
  ACCEPT_LABELS,
  DISMISS_LABELS,
};
