/**
 * `app_pop_until` — pop Navigator routes until a target predicate succeeds.
 *
 * Strategy:
 *   1. Prefer Flutter VM service when connected — evaluates a one-shot
 *      `Navigator.popUntil` expression that pops by route name, by
 *      ancestor count, or to first. This is the only reliable path for
 *      apps that use modal/bottom-sheet routes which have no AppBar back
 *      button to tap.
 *   2. Fall back to nothing else for now — apps without a VM service
 *      (release builds) should pair this tool with a tap-based recipe
 *      (PR15 + alert handler back-button labels).
 *
 * Predicates (mutually exclusive):
 *   { until: 'first' }           — pop until isFirst === true
 *   { until: 'route', name: '/' }— pop until the matching named route is current
 *   { until: 'count', count: 3 } — pop exactly count times (best-effort)
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

type PopUntil =
  | { until: 'first' }
  | { until: 'route'; name: string }
  | { until: 'count'; count: number };

function buildExpression(target: PopUntil): string {
  // `WidgetsBinding.instance.rootElement` gives an Element we can use as
  // a BuildContext for Navigator.of(). Wrapping in try/catch returns a
  // structured marker the Node side can parse.
  const predicate =
    target.until === 'first'
      ? '(r) => r.isFirst'
      : target.until === 'route'
        // Quote the name carefully — Dart single quotes don't interpolate.
        ? `(r) => r.settings.name == '${target.name.replace(/'/g, "\\'")}' || r.isFirst`
        : ''; // count handled separately below
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

export function registerAppPopUntilTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_pop_until',
      description:
        'Pop the Flutter Navigator until a target predicate is satisfied. Requires flutter_connect. ' +
        'Predicates: { until: "first" } pops to root, { until: "route", name: "/x" } pops until that named route is current, { until: "count", count: N } pops up to N times.',
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
        },
        required: ['until'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const until = params.until as 'first' | 'route' | 'count' | undefined;
      if (!until || !['first', 'route', 'count'].includes(until)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_UNTIL' }) }],
          isError: true,
        };
      }
      let target: PopUntil;
      if (until === 'route') {
        const name = params.name as string | undefined;
        if (!name) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'MISSING_NAME' }) }],
            isError: true,
          };
        }
        target = { until, name };
      } else if (until === 'count') {
        const count = Number(params.count);
        if (!Number.isFinite(count) || count <= 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_COUNT' }) }],
            isError: true,
          };
        }
        target = { until, count: Math.floor(count) };
      } else {
        target = { until };
      }

      const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId();
      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED' }) }],
          isError: true,
        };
      }
      const client = getFlutterVMClient(deviceId);
      if (!client.isConnected()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NOT_CONNECTED', message: 'Call flutter_connect first.' }) }],
          isError: true,
        };
      }

      const expr = buildExpression(target);
      try {
        const result = await client.evaluate(expr);
        const raw = (result as { valueAsString?: string }).valueAsString ?? '';
        const parsed = parsePopResult(raw);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ...parsed, target }) }],
          isError: !parsed.ok,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'EVAL_FAILED', message }) }],
          isError: true,
        };
      }
    },
  );
}

export const __forTests = { buildExpression, parsePopResult };
