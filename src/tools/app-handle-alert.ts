import { MCPServer } from '../mcp-server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveDeviceId } from './native-app-helpers';
import { getAccessibilityBridge } from '../native/accessibility-bridge';
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

const execFileAsync = promisify(execFile);

const VALID_ACTIONS = ['accept', 'dismiss'] as const;
const DEFAULT_DEVICE_WIDTH = 393;
const AX_POLL_TIMEOUT_MS = 3000;
const AX_POLL_INTERVAL_MS = 250;

type Strategy = 'ax-scan' | 'applescript-sheet' | 'permission-reset' | 'none';
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
}

/**
 * Build an AppleScript that clicks a Simulator alert button, trying every
 * label in the en/ko/ja/zh-Hans corpus for the requested action before
 * giving up.
 */
export function buildAlertScript(action: AlertAction): string {
  const labels = [
    ...flattenLabels(action),
    ...(action === 'accept' ? ['Allow', 'OK', 'Allow While Using App'] : ["Don't Allow", 'Cancel']),
  ];
  const seen = new Set<string>();
  const unique = labels.filter((l) => {
    const k = l.trim();
    if (seen.has(k) || k.length === 0) return false;
    seen.add(k);
    return true;
  });
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
  | { error: 'ax_scan_timeout' | 'no_candidate_button'; tree: AXNode | null }
> {
  const bridge = getAccessibilityBridge();
  let tree: AXNode;
  try {
    tree = await bridge.dumpTree({ deviceId });
  } catch {
    return { error: 'ax_scan_timeout', tree: null };
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
  } catch {
    return { error: 'no_candidate_button', tree };
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

async function tryAppleScript(action: AlertAction): Promise<boolean> {
  const script = buildAlertScript(action);
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
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
        'Handle system alert dialogs in the iOS Simulator (e.g. permission prompts). Accepts or dismisses the currently visible alert using an AX-scan detector (locale-aware for en/ko/ja/zh-Hans) with AppleScript fallback. Returns rich diagnostics (visibleButtons, visibleStaticTexts, suggestedLabelsToAdd) when no candidate is found.',
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
              'When Tier 1 (AX-scan) and Tier 2 (AppleScript) both miss the dialog, optionally run `xcrun simctl privacy <udid> reset <service>` with a service inferred from visibleStaticTexts. Default "none".',
          },
          dryRun: {
            type: 'boolean',
            description:
              'When fallback="permission_reset", do not actually execute simctl — report the command that would run. Default false.',
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

      const strategyAttempted: Strategy[] = [];
      let finalTree: AXNode | null = null;

      // Tier 1: AX-scan
      strategyAttempted.push('ax-scan');
      const axResult = await tryAxScan(action, deviceId);

      if ('candidate' in axResult) {
        finalTree = axResult.tree;
        const dismissed = await pollForDismissal(action, deviceId, axResult.candidate.node.path);
        const visibleButtons = collectVisibleButtonLabels(axResult.tree);
        const visibleStaticTexts = collectVisibleStaticTexts(axResult.tree);

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
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      }

      if (axResult.tree) finalTree = axResult.tree;

      // Tier 2: AppleScript fallback
      strategyAttempted.push('applescript-sheet');
      const applescriptOk = await tryAppleScript(action);

      if (applescriptOk) {
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
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      }

      // Both detection tiers failed — gather diagnostics.
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
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
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
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
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
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
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
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
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
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
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

      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    },
  );
}

/** @internal — exposed for tests only. */
export const _internal = {
  buildAlertScript,
  inferSurface,
  suggestLabels,
  ACCEPT_LABELS,
  DISMISS_LABELS,
};
