/**
 * `flutter_get_route` — best-effort current route reporter for a connected
 * Flutter app.
 *
 * Why this exists
 * ---------------
 * Tools that drive UI (tap_element, wait_for, assertions) routinely have
 * to answer "which screen is the app on right now?". Without a route hint
 * the LLM resorts to dumping the full widget tree on every step, which is
 * expensive both in token budget and in latency. The Flutter Inspector
 * doesn't expose routes through `ext.flutter.inspector.*`, so we evaluate
 * a small Dart program against the connected isolate that walks the live
 * Element tree looking for `_ModalScopeStatus` (Flutter's per-route
 * marker — every `ModalRoute` subclass wraps its content with one).
 *
 * Best-effort by design. When the rendering pipeline is mid-transition,
 * the modal route is private, or the app uses a custom Router that
 * doesn't go through Navigator at all, we return
 * `{ name: null, source: 'unknown' }` rather than guess.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

const ROUTE_EXPRESSION = `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_route:{"name":null,"source":"no_root"}';

    String? name;
    void visit(Element el) {
      if (name != null) return;
      final type = el.widget.runtimeType.toString();
      // _ModalScopeStatus is added to every ModalRoute's content subtree
      // (MaterialPageRoute, CupertinoPageRoute, dialog routes, etc.).
      // Its toString() embeds the route's settings, which carries the
      // route name when one was supplied. We parse that out rather than
      // reach into private fields.
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

    final payload = name == null
        ? 'opensafari_route:{"name":null,"source":"unknown"}'
        : 'opensafari_route:{"name":"' + name! + '","source":"modal_route"}';
    return payload;
  } catch (e) {
    return 'opensafari_route:{"name":null,"source":"error","error":"' + e.toString().replaceAll('"', "'") + '"}';
  }
})()
`.replace(/\s+/g, ' ').trim();

interface RouteResult {
  name: string | null;
  source: 'modal_route' | 'unknown' | 'no_root' | 'error';
  error?: string;
}

function parseRoutePayload(raw: string): RouteResult {
  const prefix = 'opensafari_route:';
  const idx = raw.indexOf(prefix);
  if (idx < 0) {
    return { name: null, source: 'unknown' };
  }
  try {
    return JSON.parse(raw.slice(idx + prefix.length)) as RouteResult;
  } catch {
    return { name: null, source: 'unknown' };
  }
}

export function registerFlutterGetRouteTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_get_route',
      description:
        'Report the current top-of-stack Navigator route name for the connected Flutter app. Best-effort: returns { name, source } where source is "modal_route" on success or "unknown" / "no_root" / "error" when the app uses a non-Navigator router or the tree is mid-transition. Requires flutter_connect.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses sole booted device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId();
      if (!deviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No device id available; pass device_id explicitly.' }),
          }],
          isError: true,
        };
      }

      const client = getFlutterVMClient(deviceId);
      if (!client.isConnected()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'NOT_CONNECTED', message: 'flutter_connect must be called first.' }),
          }],
          isError: true,
        };
      }

      try {
        const evalResult = await client.evaluate(ROUTE_EXPRESSION);
        const value = (evalResult as { valueAsString?: string }).valueAsString ?? '';
        const route = parseRoutePayload(value);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(route),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ name: null, source: 'error', error: message }),
          }],
          isError: true,
        };
      }
    },
  );
}

/** Exposed for unit tests so they can assert against the parse logic without
 *  hitting the network. Not part of the public surface. */
export const __forTests = { parseRoutePayload, ROUTE_EXPRESSION };
