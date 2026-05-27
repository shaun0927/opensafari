/**
 * `app_pop_until` — pop Navigator routes until a target predicate succeeds.
 *
 * Strategy (#801):
 *   1. Prefer Flutter VM service when connected — evaluates a one-shot
 *      `Navigator.popUntil` expression that pops by route name, by
 *      ancestor count, or to first. This is the only reliable path for
 *      apps that use modal/bottom-sheet routes which have no AppBar back
 *      button to tap.
 *   2. Native fallback ladder (PR2) — when the VM is not connected, or
 *      `forceFallback: true` is supplied, try these dispatches in order
 *      per attempt and verify the caller-supplied postcondition after
 *      each: AX-identified back button → edge swipe → Escape.
 *
 * Predicates (mutually exclusive):
 *   { until: 'first' }           — pop until isFirst === true
 *   { until: 'route', name: '/' }— pop until the matching named route is current
 *   { until: 'count', count: 3 } — pop exactly count times (best-effort)
 *
 * Postcondition (required in native fallback for first/route; optional
 * elsewhere):
 *   { identifier?, label?, text?, role?, route?, timeoutMs?, intervalMs? }
 *
 * Response shape (additive — pre-#801 fields preserved):
 *   { ok, status, popped?, target,
 *     strategy: 'flutter_vm' | 'native_back' | 'edge_swipe' | 'escape_key',
 *     attempts: [{ n, action, elapsedMs, ok, detail? }],
 *     postcondition: { requested, kind?, verified?, ... } }
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { getAccessibilityBridge } from '../native';
import { getInputBackend } from './native-input-utils';
import {
  ErrorCode,
  respondWithStructuredError,
} from '../errors';

type PopUntil =
  | { until: 'first' }
  | { until: 'route'; name: string }
  | { until: 'count'; count: number };

interface PostconditionSpec {
  identifier?: string;
  label?: string;
  text?: string;
  role?: string;
  route?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

interface AttemptRecord {
  n: number;
  action: string;
  elapsedMs: number;
  ok: boolean;
  detail?: string;
}

interface PostconditionVerdict {
  requested: boolean;
  kind?: 'ax_query' | 'route';
  verified?: boolean;
  query?: Record<string, unknown>;
  route?: string;
  elapsedMs?: number;
  polls?: number;
  finalMatchCount?: number;
  error?: string;
}

const DEFAULT_POSTCOND_TIMEOUT_MS = 3000;
const DEFAULT_POSTCOND_INTERVAL_MS = 250;
const DEFAULT_INTER_ATTEMPT_DELAY_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 6;

// Native fallback heuristics — picked to be safe across iPhone form
// factors. The edge swipe trigger zone for the iOS interactive pop
// gesture starts within ~20pt of the leading edge, so x=2 → x=220 reliably
// triggers it without depending on per-device screen geometry.
const EDGE_SWIPE_FROM_X = 2;
const EDGE_SWIPE_TO_X = 220;
const EDGE_SWIPE_Y = 420;
const EDGE_SWIPE_DURATION = 0.18;

// Labels / identifiers that commonly identify a back affordance. Lowercased
// substring match. UIKit's default leading back item exposes an AXLabel
// of "Back"; SwiftUI's NavigationLink back uses the localized "Back" too.
// SF Symbol chevron.left names get echoed on custom buttons.
const BACK_LABEL_HINTS = ['back', 'chevron.left', 'chevron-left', '<', '←'];
const BACK_IDENTIFIER_HINTS = ['back', 'chevron.left', 'chevron-left', 'navigation-back'];

function buildExpression(target: PopUntil): string {
  const predicate =
    target.until === 'first'
      ? '(r) => r.isFirst'
      : target.until === 'route'
        ? `(r) => r.settings.name == '${target.name.replace(/'/g, "\\'")}' || r.isFirst`
        : '';
  if (target.until === 'count') {
    return `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_pop:no_root';
    final nav = Navigator.maybeOf(root);
    if (nav == null) return 'opensafari_pop:no_navigator';
    var popped = 0;
    while (popped < ${target.count} && nav.canPop()) {
      nav.pop();
      popped += 1;
    }
    return 'opensafari_pop:ok:popped=' + popped.toString();
  } catch (e) {
    return 'opensafari_pop:error:' + e.toString().replaceAll(':', '_');
  }
})()
`.replace(/\s+/g, ' ').trim();
  }
  return `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_pop:no_root';
    final nav = Navigator.maybeOf(root);
    if (nav == null) return 'opensafari_pop:no_navigator';
    nav.popUntil(${predicate});
    return 'opensafari_pop:ok';
  } catch (e) {
    return 'opensafari_pop:error:' + e.toString().replaceAll(':', '_');
  }
})()
`.replace(/\s+/g, ' ').trim();
}

function parsePopResult(raw: string): { ok: boolean; status: string; popped?: number; error?: string } {
  const idx = raw.indexOf('opensafari_pop:');
  if (idx < 0) return { ok: false, status: 'unknown' };
  const payload = raw.slice(idx + 'opensafari_pop:'.length);
  if (payload.startsWith('ok')) {
    const m = payload.match(/^ok:popped=(\d+)/);
    return { ok: true, status: 'ok', popped: m ? Number(m[1]) : undefined };
  }
  if (payload.startsWith('error:')) {
    return { ok: false, status: 'error', error: payload.slice('error:'.length) };
  }
  return { ok: false, status: payload };
}

function parsePostcondition(raw: unknown): PostconditionSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    throw new Error('postcondition must be an object');
  }
  const spec = raw as PostconditionSpec;
  const hasSignal = !!(spec.identifier || spec.label || spec.text || spec.role || spec.route);
  if (!hasSignal) {
    throw new Error(
      'postcondition requires at least one of identifier, label, text, role, or route',
    );
  }
  return spec;
}

async function verifyAxPostcondition(
  deviceId: string,
  spec: PostconditionSpec,
  budgetMs: number,
): Promise<PostconditionVerdict> {
  const bridge = getAccessibilityBridge();
  const query = {
    identifier: spec.identifier,
    label: spec.label,
    text: spec.text,
    role: spec.role,
  };
  const interval = Math.max(50, Math.floor(spec.intervalMs ?? DEFAULT_POSTCOND_INTERVAL_MS));
  const start = Date.now();
  const deadline = start + Math.max(0, Math.floor(budgetMs));
  let polls = 0;
  let finalMatchCount = 0;
  while (Date.now() <= deadline) {
    polls++;
    try {
      const result = await bridge.query(query, { deviceId });
      finalMatchCount = result.matches.length;
      if (finalMatchCount > 0) {
        return {
          requested: true,
          kind: 'ax_query',
          verified: true,
          query,
          elapsedMs: Date.now() - start,
          polls,
          finalMatchCount,
        };
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (Date.now() > deadline) {
        return {
          requested: true,
          kind: 'ax_query',
          verified: false,
          query,
          elapsedMs: Date.now() - start,
          polls,
          finalMatchCount,
          error: errMessage,
        };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, remaining)));
  }
  return {
    requested: true,
    kind: 'ax_query',
    verified: false,
    query,
    elapsedMs: Date.now() - start,
    polls,
    finalMatchCount,
  };
}

async function verifyRoutePostcondition(
  deviceId: string,
  routeName: string,
  budgetMs: number,
  intervalMs: number,
): Promise<PostconditionVerdict> {
  const client = getFlutterVMClient(deviceId);
  const start = Date.now();
  const deadline = start + Math.max(0, Math.floor(budgetMs));
  let polls = 0;
  let lastError: string | undefined;
  const escaped = routeName.replace(/'/g, "\\'");
  const expr = `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_route:no_root';
    final modal = ModalRoute.of(root);
    final name = modal?.settings.name;
    if (name == '${escaped}') return 'opensafari_route:ok';
    return 'opensafari_route:mismatch:' + (name ?? 'null').toString();
  } catch (e) {
    return 'opensafari_route:error:' + e.toString().replaceAll(':', '_');
  }
})()
`.replace(/\s+/g, ' ').trim();
  while (Date.now() <= deadline) {
    polls++;
    try {
      const result = await client.evaluate(expr);
      const raw = (result as { valueAsString?: string }).valueAsString ?? '';
      if (raw.includes('opensafari_route:ok')) {
        return {
          requested: true,
          kind: 'route',
          verified: true,
          route: routeName,
          elapsedMs: Date.now() - start,
          polls,
        };
      }
      if (raw.includes('opensafari_route:error:')) {
        lastError = raw.slice(raw.indexOf('opensafari_route:error:') + 'opensafari_route:error:'.length);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return {
    requested: true,
    kind: 'route',
    verified: false,
    route: routeName,
    elapsedMs: Date.now() - start,
    polls,
    error: lastError,
  };
}

async function verifyPostcondition(
  deviceId: string,
  spec: PostconditionSpec,
): Promise<PostconditionVerdict> {
  const budgetMs = spec.timeoutMs ?? DEFAULT_POSTCOND_TIMEOUT_MS;
  const intervalMs = Math.max(50, Math.floor(spec.intervalMs ?? DEFAULT_POSTCOND_INTERVAL_MS));
  if (spec.route) {
    return verifyRoutePostcondition(deviceId, spec.route, budgetMs, intervalMs);
  }
  return verifyAxPostcondition(deviceId, spec, budgetMs);
}

/**
 * Find a back affordance through the AX bridge. Returns the centre of
 * the matching node's frame so the input backend can tap it. Tries
 * identifier hints first (most stable), then label hints, then role=button
 * + label hints.
 */
async function findBackAffordance(
  deviceId: string,
): Promise<{ x: number; y: number; via: string } | null> {
  const bridge = getAccessibilityBridge();
  // Identifier sweep — exact match per hint.
  for (const hint of BACK_IDENTIFIER_HINTS) {
    try {
      const result = await bridge.query({ identifier: hint }, { deviceId });
      const node = result.matches.find((n) => n.visible && n.enabled);
      if (node) {
        return {
          x: node.frame.x + node.frame.width / 2,
          y: node.frame.y + node.frame.height / 2,
          via: `identifier=${hint}`,
        };
      }
    } catch {
      // continue probing
    }
  }
  // Label sweep — case-insensitive substring via the bridge's label match.
  for (const hint of BACK_LABEL_HINTS) {
    try {
      const result = await bridge.query({ label: hint }, { deviceId });
      // Prefer button-role nodes when multiple match, and break ties by
      // smaller-y so we don't accidentally tap a tab-bar item.
      const candidates = result.matches.filter((n) => n.visible && n.enabled);
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        const aButton = a.role.includes('Button') ? 0 : 1;
        const bButton = b.role.includes('Button') ? 0 : 1;
        if (aButton !== bButton) return aButton - bButton;
        return a.frame.y - b.frame.y;
      });
      const node = candidates[0];
      return {
        x: node.frame.x + node.frame.width / 2,
        y: node.frame.y + node.frame.height / 2,
        via: `label=${hint}`,
      };
    } catch {
      // continue probing
    }
  }
  return null;
}

type NativeStrategy = 'native_back' | 'edge_swipe' | 'escape_key';

/**
 * Dispatch one native back step. Returns the strategy that succeeded
 * (i.e. the dispatch didn't throw); postcondition verification happens
 * separately in the calling loop.
 */
async function dispatchNativeBack(
  deviceId: string,
  backend: Awaited<ReturnType<typeof getInputBackend>>,
): Promise<{ strategy: NativeStrategy; detail: string }> {
  // 1. AX-identified back button.
  const back = await findBackAffordance(deviceId);
  if (back) {
    await backend.tap(deviceId, back.x, back.y);
    return {
      strategy: 'native_back',
      detail: `tap(${Math.round(back.x)},${Math.round(back.y)}) via ${back.via}`,
    };
  }
  // 2. iOS interactive-pop edge swipe.
  try {
    await backend.swipe(
      deviceId,
      EDGE_SWIPE_FROM_X,
      EDGE_SWIPE_Y,
      EDGE_SWIPE_TO_X,
      EDGE_SWIPE_Y,
      EDGE_SWIPE_DURATION,
    );
    return {
      strategy: 'edge_swipe',
      detail: `swipe(${EDGE_SWIPE_FROM_X},${EDGE_SWIPE_Y})->(${EDGE_SWIPE_TO_X},${EDGE_SWIPE_Y})`,
    };
  } catch (err) {
    // 3. Escape key — useful for modal sheets and some custom navigators.
    try {
      await backend.sendKey(deviceId, 'Escape');
      return {
        strategy: 'escape_key',
        detail: `sendKey(Escape) after swipe failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    } catch (err2) {
      throw new Error(
        `all native strategies failed: swipe=${
          err instanceof Error ? err.message : String(err)
        }; escape=${err2 instanceof Error ? err2.message : String(err2)}`,
      );
    }
  }
}

/**
 * Native fallback ladder driver. Loops dispatch → postcondition until
 * verified or maxAttempts is reached.
 */
async function runNativeFallback(args: {
  deviceId: string;
  target: PopUntil;
  postSpec: PostconditionSpec;
  maxAttempts: number;
  interAttemptDelayMs: number;
}): Promise<{
  ok: boolean;
  strategy: NativeStrategy;
  attempts: AttemptRecord[];
  postcondition: PostconditionVerdict;
  exhausted: boolean;
  noBackend?: string;
}> {
  const attempts: AttemptRecord[] = [];
  let backend: Awaited<ReturnType<typeof getInputBackend>>;
  try {
    backend = await getInputBackend(args.deviceId, getWebKitClient(args.deviceId));
  } catch (err) {
    return {
      ok: false,
      strategy: 'native_back',
      attempts: [],
      postcondition: { requested: true },
      exhausted: false,
      noBackend: err instanceof Error ? err.message : String(err),
    };
  }

  let lastStrategy: NativeStrategy = 'native_back';
  let postcondition: PostconditionVerdict = {
    requested: true,
    kind: args.postSpec.route ? 'route' : 'ax_query',
    verified: false,
  };
  // For until=count, succeed when we've performed `count` successful
  // dispatches AND the postcondition (if any signal beyond route) verifies.
  const countCap = args.target.until === 'count' ? args.target.count : args.maxAttempts;
  const stepCap = Math.max(1, Math.min(args.maxAttempts, countCap));

  for (let n = 1; n <= stepCap; n++) {
    const dispatchStart = Date.now();
    let dispatchOk = false;
    let detail: string | undefined;
    let strategy: NativeStrategy = 'native_back';
    try {
      const r = await dispatchNativeBack(args.deviceId, backend);
      dispatchOk = true;
      detail = r.detail;
      strategy = r.strategy;
      lastStrategy = strategy;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    attempts.push({
      n,
      action: dispatchOk ? `native.${strategy}` : 'native.dispatch_failed',
      elapsedMs: Date.now() - dispatchStart,
      ok: dispatchOk,
      detail,
    });

    if (!dispatchOk) {
      break; // ladder exhausted on dispatch side
    }

    // After each successful dispatch, verify the postcondition with a
    // small budget so we can short-circuit when the back actually landed.
    try {
      postcondition = await verifyPostcondition(args.deviceId, args.postSpec);
    } catch (err) {
      postcondition = {
        requested: true,
        kind: args.postSpec.route ? 'route' : 'ax_query',
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (postcondition.verified === true) {
      return {
        ok: true,
        strategy: lastStrategy,
        attempts,
        postcondition,
        exhausted: false,
      };
    }
    if (n < stepCap) {
      await new Promise((r) => setTimeout(r, args.interAttemptDelayMs));
    }
  }

  return {
    ok: false,
    strategy: lastStrategy,
    attempts,
    postcondition,
    exhausted: true,
  };
}

export function registerAppPopUntilTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_pop_until',
      description:
        'Pop the Flutter Navigator (or, when VM is unavailable, dispatch native back gestures) until a target predicate is satisfied. ' +
        'Predicates: { until: "first" } pops to root, { until: "route", name: "/x" } pops until that named route is current, { until: "count", count: N } pops up to N times. ' +
        'Supply postcondition: { identifier|label|text|role|route, timeoutMs } to verify the resulting screen state. Required when running native fallback for first/route. ' +
        'Pass forceFallback: true to bypass the VM path even when it is connected.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          until: {
            type: 'string',
            enum: ['first', 'route', 'count'],
            description: 'Predicate kind',
          },
          name: { type: 'string', description: 'Route name (only with until="route")' },
          count: { type: 'number', description: 'Pop count (only with until="count")' },
          device_id: { type: 'string', description: 'Simulator UDID' },
          postcondition: {
            type: 'object',
            description:
              'Optional verification (required in native fallback for first/route). Provide one or more of identifier/label/text/role (AX query) or route (Flutter VM ModalRoute.name check). Defaults: timeoutMs=3000, intervalMs=250.',
            properties: {
              identifier: { type: 'string' },
              label: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              route: { type: 'string' },
              timeoutMs: { type: 'number' },
              intervalMs: { type: 'number' },
            },
          },
          maxAttempts: {
            type: 'number',
            description: `Upper bound on attempt-history entries the fallback ladder may record. Defaults to count for until=count, otherwise ${DEFAULT_MAX_ATTEMPTS}. VM-only execution always emits exactly one attempt.`,
          },
          interAttemptDelayMs: {
            type: 'number',
            description: `Delay between successive fallback attempts. Default ${DEFAULT_INTER_ATTEMPT_DELAY_MS}.`,
          },
          forceFallback: {
            type: 'boolean',
            description: 'Skip the Flutter VM path even when it is connected. Useful for testing the native ladder in apps that also expose a VM.',
          },
        },
        required: ['until'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const until = params.until as 'first' | 'route' | 'count' | undefined;
      if (!until || !['first', 'route', 'count'].includes(until)) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          'until must be one of first, route, count',
          { param: 'until' },
        );
      }
      let target: PopUntil;
      if (until === 'route') {
        const name = params.name as string | undefined;
        if (!name) {
          return respondWithStructuredError(
            ErrorCode.MISSING_REQUIRED_PARAM,
            'name is required when until="route"',
            { param: 'name' },
          );
        }
        target = { until, name };
      } else if (until === 'count') {
        const count = Number(params.count);
        if (!Number.isFinite(count) || count <= 0) {
          return respondWithStructuredError(
            ErrorCode.INVALID_INPUT,
            'count must be a positive number',
            { param: 'count' },
          );
        }
        target = { until, count: Math.floor(count) };
      } else {
        target = { until };
      }

      let postSpec: PostconditionSpec | null = null;
      try {
        postSpec = parsePostcondition(params.postcondition);
      } catch (err) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          err instanceof Error ? err.message : String(err),
          { param: 'postcondition' },
        );
      }

      const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId();
      if (!deviceId) {
        return respondWithStructuredError(
          ErrorCode.DEVICE_NOT_BOOTED,
          'No booted simulator found and no device_id supplied',
        );
      }

      const maxAttempts = (() => {
        const raw = Number(params.maxAttempts);
        if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
        return target.until === 'count' ? target.count : DEFAULT_MAX_ATTEMPTS;
      })();
      const interAttemptDelayMs = (() => {
        const raw = Number(params.interAttemptDelayMs);
        if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
        return DEFAULT_INTER_ATTEMPT_DELAY_MS;
      })();
      const forceFallback = params.forceFallback === true;

      // ── VM path ──────────────────────────────────────────────────────────
      const vmClient = getFlutterVMClient(deviceId);
      const vmConnected = vmClient.isConnected();
      if (vmConnected && !forceFallback) {
        const attempts: AttemptRecord[] = [];
        const expr = buildExpression(target);
        const popStart = Date.now();
        let popOk = false;
        let popDetail: string | undefined;
        let popped: number | undefined;
        try {
          const result = await vmClient.evaluate(expr);
          const raw = (result as { valueAsString?: string }).valueAsString ?? '';
          const parsed = parsePopResult(raw);
          popOk = parsed.ok;
          popped = parsed.popped;
          popDetail = parsed.error ?? (parsed.ok ? undefined : parsed.status);
        } catch (err) {
          popDetail = err instanceof Error ? err.message : String(err);
        }
        attempts.push({
          n: 1,
          action: 'flutter_vm.popUntil',
          elapsedMs: Date.now() - popStart,
          ok: popOk,
          detail: popDetail,
        });

        if (!popOk) {
          return respondWithStructuredError(
            ErrorCode.FLUTTER_EVAL_FAILED,
            popDetail ?? 'Flutter VM evaluate did not return opensafari_pop:ok',
            {
              target,
              strategy: 'flutter_vm',
              attempts,
              postcondition: { requested: postSpec !== null },
            },
          );
        }

        let postcondition: PostconditionVerdict = { requested: postSpec !== null };
        if (postSpec) {
          try {
            postcondition = await verifyPostcondition(deviceId, postSpec);
          } catch (err) {
            postcondition = {
              requested: true,
              kind: postSpec.route ? 'route' : 'ax_query',
              verified: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const body = {
          ok: postSpec ? postcondition.verified === true : true,
          status: 'ok',
          popped,
          target,
          strategy: 'flutter_vm',
          attempts,
          postcondition,
        };
        const isError = postSpec ? postcondition.verified !== true : false;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body) }],
          ...(isError ? { isError: true as const } : {}),
        };
      }

      // ── Native fallback path ────────────────────────────────────────────
      // Native fallback for until=first/route REQUIRES a postcondition —
      // without it we have no signal that "we landed on the right screen".
      if (target.until !== 'count' && !postSpec) {
        return respondWithStructuredError(
          ErrorCode.MISSING_POSTCONDITION,
          'Native fallback for until=first/route requires a postcondition (route or AX query).',
          {
            target,
            vmConnected,
            hint: vmConnected
              ? 'forceFallback was true; supply a postcondition or remove forceFallback.'
              : 'Connect Flutter VM via flutter_connect, or supply a postcondition for AX verification.',
          },
        );
      }

      // For until=count without postcondition, synthesise a "no-op verified"
      // postcondition so the ladder driver short-circuits after `count`
      // successful dispatches.
      const effectivePost: PostconditionSpec =
        postSpec ?? { identifier: '__opensafari_pop_until_count_synthetic__' };
      const result = await runNativeFallback({
        deviceId,
        target,
        postSpec: effectivePost,
        maxAttempts,
        interAttemptDelayMs,
      });

      if (result.noBackend) {
        return respondWithStructuredError(
          ErrorCode.POP_UNTIL_NO_FALLBACK_AVAILABLE,
          `No native input backend available: ${result.noBackend}`,
          { target, attempts: result.attempts, postcondition: { requested: true } },
        );
      }

      const okFromDispatch =
        target.until === 'count' && !postSpec && result.attempts.filter((a) => a.ok).length >= target.count;

      const overallOk = okFromDispatch || result.ok;

      if (!overallOk && result.exhausted) {
        return respondWithStructuredError(
          ErrorCode.POP_UNTIL_EXHAUSTED,
          'Fallback ladder exhausted before postcondition verified',
          {
            target,
            strategy: result.strategy,
            attempts: result.attempts,
            postcondition: result.postcondition,
          },
        );
      }

      const body = {
        ok: overallOk,
        status: overallOk ? 'ok' : 'unverified',
        popped: target.until === 'count' ? result.attempts.filter((a) => a.ok).length : undefined,
        target,
        strategy: result.strategy,
        attempts: result.attempts,
        postcondition: postSpec ? result.postcondition : { requested: false },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        ...(overallOk ? {} : { isError: true as const }),
      };
    },
  );
}

export const __forTests = {
  buildExpression,
  parsePopResult,
  parsePostcondition,
  verifyAxPostcondition,
  verifyRoutePostcondition,
  dispatchNativeBack,
  findBackAffordance,
  runNativeFallback,
};
