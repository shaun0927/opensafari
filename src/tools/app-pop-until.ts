/**
 * `app_pop_until` — pop Navigator routes until a target predicate succeeds.
 *
 * Strategy (PR1 of #801 — contract extension):
 *   1. Prefer Flutter VM service when connected — evaluates a one-shot
 *      `Navigator.popUntil` expression that pops by route name, by
 *      ancestor count, or to first. This is the only reliable path for
 *      apps that use modal/bottom-sheet routes which have no AppBar back
 *      button to tap.
 *   2. A native-fallback ladder (system back / app-bar chevron / edge swipe /
 *      Escape) lands in #801 PR2. This PR adds the postcondition and
 *      attempt-history shape that the fallback ladder will produce.
 *
 * Predicates (mutually exclusive):
 *   { until: 'first' }           — pop until isFirst === true
 *   { until: 'route', name: '/' }— pop until the matching named route is current
 *   { until: 'count', count: 3 } — pop exactly count times (best-effort)
 *
 * Optional postcondition (any combination — at least one of identifier /
 * label / text / role / route required when supplied):
 *   postcondition: {
 *     identifier?, label?, text?, role?,  // AX query
 *     route?,                              // Flutter route name (VM only)
 *     timeoutMs?,                          // default 3000
 *   }
 *
 * Response shape (additive — pre-#801 fields preserved):
 *   { ok, status, popped?, target,
 *     strategy: 'flutter_vm' | ...future fallbacks,
 *     attempts: [{ n, action, elapsedMs, ok, detail? }],
 *     postcondition: { requested, kind?, verified?, query?, route?,
 *                      elapsedMs?, polls?, finalMatchCount?, error? } }
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { getAccessibilityBridge } from '../native';
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
      // Best-effort — keep polling until deadline, but surface the last
      // error if we never verify.
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

function buildRoutePostconditionExpression(routeName: string): string {
  const escaped = routeName.replace(/'/g, "\\'");
  return `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_route:no_root';

    String? name;
    void visit(Element el) {
      if (name != null) return;
      final type = el.widget.runtimeType.toString();
      if (type == '_ModalScopeStatus') {
        final s = el.toString();
        final match = RegExp(r'name:\\s*"([^"]+)"').firstMatch(s)
            ?? RegExp(r"name:\\s*'([^']+)'").firstMatch(s)
            ?? RegExp(r'RouteSettings\\("([^"]+)"').firstMatch(s);
        if (match != null) name = match.group(1);
      }
      el.visitChildren(visit);
    }
    visit(root);

    if (name == '${escaped}') return 'opensafari_route:ok';
    return 'opensafari_route:mismatch:' + (name ?? 'null').toString();
  } catch (e) {
    return 'opensafari_route:error:' + e.toString().replaceAll(':', '_');
  }
})()
`.replace(/\s+/g, ' ').trim();
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
  const expr = buildRoutePostconditionExpression(routeName);
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
  // route postcondition (Flutter VM) wins when both supplied — it's the
  // strongest signal for navigation success.
  if (spec.route) {
    return verifyRoutePostcondition(deviceId, spec.route, budgetMs, intervalMs);
  }
  return verifyAxPostcondition(deviceId, spec, budgetMs);
}

export function registerAppPopUntilTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_pop_until',
      description:
        'Pop the Flutter Navigator until a target predicate is satisfied. ' +
        'Predicates: { until: "first" } pops to root, { until: "route", name: "/x" } pops until that named route is current, { until: "count", count: N } pops up to N times. ' +
        'Supply postcondition: { identifier|label|text|role|route, timeoutMs } to verify the resulting screen state. ' +
        'Native fallback ladder ships in #801 PR2; this PR requires Flutter VM service (call flutter_connect first).',
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
              'Optional verification. Provide one or more of identifier/label/text/role (AX query) or route (Flutter VM ModalRoute.name check). Defaults: timeoutMs=3000, intervalMs=250.',
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

      // Postcondition spec (optional in VM-path; required in native fallback — enforced in PR2).
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

      const client = getFlutterVMClient(deviceId);
      if (!client.isConnected()) {
        return respondWithStructuredError(
          ErrorCode.FLUTTER_VM_NOT_CONNECTED,
          'Call flutter_connect first. Native fallback ladder ships in #801 PR2.',
          { target, deviceId },
        );
      }

      const attempts: AttemptRecord[] = [];
      const expr = buildExpression(target);
      const popStart = Date.now();
      let popOk = false;
      let popDetail: string | undefined;
      let popped: number | undefined;
      try {
        const result = await client.evaluate(expr);
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

      // Optional postcondition verification.
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
    },
  );
}

export const __forTests = {
  buildExpression,
  parsePopResult,
  parsePostcondition,
  verifyAxPostcondition,
  verifyRoutePostcondition,
  buildRoutePostconditionExpression,
};
