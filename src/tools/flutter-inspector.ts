/**
 * flutter_root_widget + flutter_inspect_selection (issue #436)
 *
 * Two MCP tools that expose the Flutter Inspector service extensions
 * for LLM-driven widget introspection:
 *
 *   - flutter_root_widget:       returns the widget summary tree.
 *   - flutter_inspect_selection: returns the currently selected widget.
 *
 * Coordinate→widget mapping (`flutter_widget_at_point`) is NOT shipped
 * in this PR — it requires a toggle/tap/read sequence that crosses
 * `app_tap` and the inspector overlay. Tracked as a follow-up on #436.
 *
 * Requires an active flutter_connect session (debug / profile builds).
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

// ── Shared helpers ──────────────────────────────────────────────────────────

async function resolveClient(paramDeviceId: unknown): Promise<{ deviceId: string; client: ReturnType<typeof getFlutterVMClient> }> {
  const deviceId =
    (typeof paramDeviceId === 'string' ? paramDeviceId : undefined) ??
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw new Error('No device specified and no active device. Boot a simulator first.');
  }
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
  }
  return { deviceId, client };
}

/**
 * Compact summary of a widget inspector node for LLM consumption.
 * Keeps the most useful fields and drops framework noise (state objects,
 * hashCodes, render objects) that the raw inspector payload contains.
 */
export interface WidgetSummary {
  type: string;
  description?: string;
  valueId?: string;
  creationLocation?: { file: string; line: number; column: number };
  widgetRuntimeType?: string;
  stateful?: boolean;
  children?: WidgetSummary[];
}

const MAX_DEPTH_CAP = 64;

export function summariseNode(
  node: unknown,
  maxDepth = 8,
  visited?: WeakSet<object>,
): WidgetSummary | null {
  if (!node || typeof node !== 'object') return null;
  const seen = visited ?? new WeakSet<object>();
  if (seen.has(node as object)) {
    // Defensive cycle guard. Summary trees should be DAGs, but a malformed
    // payload or future Flutter change could introduce one.
    return { type: 'CycleDetected' };
  }
  seen.add(node as object);
  const n = node as Record<string, unknown>;

  const type = typeof n.type === 'string' ? n.type : (typeof n.description === 'string' ? n.description : 'Unknown');
  const creationLocation =
    n.creationLocation && typeof n.creationLocation === 'object'
      ? (() => {
          const cl = n.creationLocation as Record<string, unknown>;
          const file = typeof cl.file === 'string' ? cl.file : undefined;
          const line = typeof cl.line === 'number' ? cl.line : undefined;
          const column = typeof cl.column === 'number' ? cl.column : undefined;
          if (file && line !== undefined && column !== undefined) {
            return { file, line, column };
          }
          return undefined;
        })()
      : undefined;

  const summary: WidgetSummary = {
    type,
    description: typeof n.description === 'string' ? n.description : undefined,
    valueId: typeof n.valueId === 'string' ? n.valueId : undefined,
    creationLocation,
    widgetRuntimeType: typeof n.widgetRuntimeType === 'string' ? n.widgetRuntimeType : undefined,
    stateful: typeof n.stateful === 'boolean' ? n.stateful : undefined,
  };

  if (maxDepth > 0 && Array.isArray(n.children)) {
    summary.children = (n.children as unknown[])
      .map((c) => summariseNode(c, maxDepth - 1, seen))
      .filter((c): c is WidgetSummary => c !== null);
  }

  return summary;
}

// ── flutter_root_widget ─────────────────────────────────────────────────────

export function registerFlutterRootWidgetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_root_widget',
      description:
        'Return the widget summary tree of the running Flutter app ' +
        '(via ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews). ' +
        'Each node includes type, description, and creationLocation (file:line:column) ' +
        'for direct source navigation. Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          object_group: {
            type: 'string',
            description: 'Inspector object-group name for memory lifetime scoping (default: "opensafari-root").',
          },
          max_depth: {
            type: 'number',
            description: 'Maximum tree depth to include in the summary (default: 8).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const { deviceId, client } = await resolveClient(params.device_id);
        // Clamp to [0, MAX_DEPTH_CAP] with NaN / Infinity rejected.
        const rawDepth = params.max_depth;
        const maxDepth =
          typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth >= 0
            ? Math.min(Math.floor(rawDepth), MAX_DEPTH_CAP)
            : 8;

        const raw = await client.getRootWidgetSummaryTree({
          objectGroup: typeof params.object_group === 'string' ? params.object_group : undefined,
        });

        const root = raw.result ?? raw;
        const summary = summariseNode(root, maxDepth);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              tree: summary,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_root_widget] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

// ── flutter_inspect_selection ───────────────────────────────────────────────

export function registerFlutterInspectSelectionTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_inspect_selection',
      description:
        'Return the currently selected widget via ext.flutter.inspector.getSelectedSummaryWidget. ' +
        'Selection is normally established by toggling the in-app widget inspector overlay ' +
        '(set show=true in the tool, tap on the running app, read the selection, then set show=false). ' +
        'Returns type, description, and creationLocation so the caller can jump to source.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          show: {
            type: 'boolean',
            description: 'If provided, toggle the in-app inspector overlay before reading (true = enable, false = disable). Use this to arm/disarm coord-based selection.',
          },
          object_group: {
            type: 'string',
            description: 'Inspector object-group name (default: "opensafari-selection").',
          },
          previous_selection_id: {
            type: 'string',
            description: 'Previous selection valueId — lets the VM reuse existing group objects.',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const { deviceId, client } = await resolveClient(params.device_id);

        if (typeof params.show === 'boolean') {
          await client.setInspectorShow(params.show);
        }

        const raw = await client.getSelectedWidget({
          objectGroup: typeof params.object_group === 'string' ? params.object_group : undefined,
          previousSelectionId: typeof params.previous_selection_id === 'string'
            ? params.previous_selection_id
            : undefined,
        });

        const node = (raw.result ?? raw) as Record<string, unknown>;
        // isWidgetSelection rejects VM Service metadata-only responses (e.g. type="_extensionType"
        // or "Sentinel") that the VM returns when no widget is actually selected.
        const isWidgetSelection = (n: Record<string, unknown>): boolean => {
          if (typeof n.valueId === 'string' && n.valueId.length > 0) return true;
          const t = typeof n.type === 'string' ? n.type : '';
          // Reject VM Service metadata-only responses
          if (t.startsWith('_extension') || t === 'Sentinel') return false;
          return !!(t || n.description);
        };
        const hasSelection = isWidgetSelection(node);
        const selection = hasSelection ? summariseNode(node, 0) : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: hasSelection ? 'ok' : 'empty',
              deviceId,
              selection,
              hint: hasSelection
                ? undefined
                : 'No widget currently selected. Call with show=true, tap a widget in the simulator, then call again with show=false.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_inspect_selection] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
