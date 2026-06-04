/**
 * flutter_widget_at_point (issue #436 follow-up)
 *
 * MCP tool that maps a physical-pixel coordinate (matching simulator
 * screenshots) to the topmost widget at that point, with source location
 * and a filtered ancestor chain of user-defined widgets.
 *
 * Flutter 3.11 does NOT expose `ext.flutter.inspector.screenToSummaryTree`
 * (verified against the live service-extension list on iPhone 16 sim).
 * Instead, the mapping is performed by evaluating a Dart expression via
 * the VM Service that:
 *   1. Converts physical (x,y) → logical using `MediaQuery.devicePixelRatio`.
 *   2. Runs `renderView.hitTest(HitTestResult(), position: Offset(...))`.
 *   3. Picks the topmost `RenderBox` whose `debugCreator` points at an
 *      `Element`.
 *   4. Pushes that `Element` into `WidgetInspectorService.instance.setSelection`.
 *   5. Reads back `getSelectedSummaryWidget`.
 *
 * `ancestor_chain` is obtained from `ext.flutter.inspector.getParentChain`
 * and filtered down to user-defined widgets — any node whose
 * `creationLocation.file` resolves inside the Flutter SDK (`package:flutter/`,
 * `package:flutter_*`, or paths containing `/flutter/packages/flutter`) is
 * dropped.
 *
 * Requires an active flutter_connect session (debug / profile builds).
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { summariseNode, type WidgetSummary } from './flutter-inspector';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';

// ── Shared helpers ──────────────────────────────────────────────────────────

async function resolveClient(paramDeviceId: unknown): Promise<{
  deviceId: string;
  client: ReturnType<typeof getFlutterVMClient>;
}> {
  const deviceId =
    (typeof paramDeviceId === 'string' ? paramDeviceId : undefined) ??
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first.');
  }
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    throw StructuredErrorException.fromCode(ErrorCode.FLUTTER_VM_NOT_CONNECTED, 'Not connected to Flutter VM Service. Run flutter_connect first.');
  }
  return { deviceId, client };
}

/**
 * Read the MediaQuery's devicePixelRatio + screen size via `flutter_evaluate`.
 * Returns `{ devicePixelRatio, widthPhysical, heightPhysical }`. Falls back to
 * `view.devicePixelRatio` / `view.physicalSize` if `MediaQueryData.fromView`
 * is not available.
 */
export async function readViewMetrics(
  client: ReturnType<typeof getFlutterVMClient>,
): Promise<{ devicePixelRatio: number; widthPhysical: number; heightPhysical: number }> {
  // NOTE: We read the main FlutterView to get both DPR and physical size,
  // which lets us reject out-of-bounds coordinates without a hit-test.
  const expression =
    '(() {' +
    '  final view = WidgetsBinding.instance.platformDispatcher.views.first;' +
    '  final dpr = view.devicePixelRatio;' +
    '  final size = view.physicalSize;' +
    '  return "${dpr}|${size.width}|${size.height}";' +
    '})()';

  const raw = await client.evaluate(expression);
  const valueAsString = (raw as { valueAsString?: string }).valueAsString;
  if (typeof valueAsString !== 'string') {
    throw new Error('Unable to read FlutterView metrics (no valueAsString)');
  }
  const parts = valueAsString.split('|').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Unable to parse FlutterView metrics: "${valueAsString}"`);
  }
  const [devicePixelRatio, widthPhysical, heightPhysical] = parts;
  return { devicePixelRatio, widthPhysical, heightPhysical };
}

// Flutter SDK path markers. Any creationLocation.file that matches one of
// these is considered framework/SDK code and is dropped from the ancestor
// chain, leaving only user-defined widgets.
const FLUTTER_SDK_MARKERS = [
  'package:flutter/',
  'package:flutter_localizations/',
  'package:flutter_test/',
  'package:flutter_web_plugins/',
  '/flutter/packages/flutter/',
  '/flutter/packages/flutter_',
  '/hosted/pub.dartlang.org/flutter',
  '/hosted/pub.dev/flutter',
];

export function isUserDefinedWidget(node: WidgetSummary | null | undefined): boolean {
  if (!node) return false;
  const file = node.creationLocation?.file;
  // Widgets without a creationLocation are skipped (SDK internals typically
  // strip creation locations; user code always has them when built with
  // `--track-widget-creation`, which is the Flutter debug default).
  if (!file) return false;
  return !FLUTTER_SDK_MARKERS.some((marker) => file.includes(marker));
}

/**
 * Extract `{ type, description, creation_location, widget_id }` from an
 * inspector payload (already one-level summarised).
 *
 * The raw inspector node wraps every widget in `_ElementDiagnosticableTreeNode`,
 * so `summary.type` carries the wrapper class, not the Flutter widget name.
 * Prefer `widgetRuntimeType` (always the user-visible widget, e.g.
 * `"ElevatedButton"`), then `description`, and fall back to `type` only when
 * neither is present so the public `widget_type` identifies the widget.
 */
function toPublicShape(summary: WidgetSummary): {
  widget_type: string;
  description?: string;
  widget_id?: string;
  creation_location?: { file: string; line: number; column: number };
} {
  return {
    widget_type: summary.widgetRuntimeType ?? summary.description ?? summary.type,
    description: summary.description,
    widget_id: summary.valueId,
    creation_location: summary.creationLocation,
  };
}

/**
 * Flatten the `getParentChain` response into `WidgetSummary[]`.
 *
 * Three payload shapes are seen in the wild:
 *   1. `{ chain: [{ node: {...}, children: [...] }, ...] }` — synthetic /
 *      DevTools fixtures.
 *   2. `{ result: { chain: [...] } }` — wrapped chain from older inspector
 *      variants.
 *   3. `{ type: "_extensionType", result: [{ node: {...}, children: [...] }, ...] }`
 *      — the live Flutter 3.11+ VM Service response, where the top-level
 *      `result` key *is* the chain array. The pre-fix code only recognised
 *      shapes (1) and (2), so `ancestor_chain` was always empty against
 *      real apps (issue #436 live verification).
 */
export function flattenParentChain(raw: Record<string, unknown>): WidgetSummary[] {
  const resultField = (raw as { result?: unknown }).result;
  const chain =
    (raw as { chain?: unknown[] }).chain ??
    (Array.isArray(resultField)
      ? resultField
      : (resultField as { chain?: unknown[] } | undefined)?.chain) ??
    [];

  if (!Array.isArray(chain)) return [];

  const out: WidgetSummary[] = [];
  for (const entry of chain) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    // Prefer an explicit `node` field; fall back to the entry itself.
    const node = (e.node && typeof e.node === 'object') ? e.node : entry;
    const summary = summariseNode(node, 0);
    if (summary) out.push(summary);
  }
  return out;
}

// ── flutter_widget_at_point ────────────────────────────────────────────────

export function registerFlutterWidgetAtPointTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_widget_at_point',
      description:
        'Map a physical-pixel coordinate (matching simulator screenshots) to ' +
        'the topmost Flutter widget at that point. Converts physical → logical ' +
        'pixels via MediaQuery.devicePixelRatio, performs a Dart-side hit-test, ' +
        'and returns {widget_type, description, creation_location, widget_id, ' +
        'ancestor_chain}. Out-of-bounds input returns {widget_type: null, ' +
        'reason: "out-of-bounds"}. Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          x: {
            type: 'number',
            description: 'Physical-pixel X coordinate (matches simulator screenshot).',
          },
          y: {
            type: 'number',
            description: 'Physical-pixel Y coordinate (matches simulator screenshot).',
          },
          object_group: {
            type: 'string',
            description: 'Inspector object-group name (default: "opensafari-hit").',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['x', 'y'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const { deviceId, client } = await resolveClient(params.device_id);

        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'x and y must be finite numbers');
        }

        const objectGroup = typeof params.object_group === 'string'
          ? params.object_group
          : 'opensafari-hit';

        // 1. Read FlutterView metrics to validate bounds + derive DPR.
        const metrics = await readViewMetrics(client);

        if (
          x < 0 || y < 0 ||
          x >= metrics.widthPhysical || y >= metrics.heightPhysical
        ) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'ok',
                deviceId,
                widget_type: null,
                reason: 'out-of-bounds',
                view: {
                  width_physical: metrics.widthPhysical,
                  height_physical: metrics.heightPhysical,
                  device_pixel_ratio: metrics.devicePixelRatio,
                },
              }, null, 2),
            }],
          };
        }

        // 2. Perform the hit-test + selection via the VM client.
        const hitResult = await client.selectWidgetAtPoint({
          physicalX: x,
          physicalY: y,
          devicePixelRatio: metrics.devicePixelRatio,
          objectGroup,
        });

        if (!(hitResult as { hit?: boolean }).hit) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'ok',
                deviceId,
                widget_type: null,
                reason: 'no-hit',
              }, null, 2),
            }],
          };
        }

        const rawSelection =
          (hitResult as { selection?: Record<string, unknown> }).selection ?? {};
        const selectionNode =
          (rawSelection as { result?: Record<string, unknown> }).result ?? rawSelection;
        const summary = summariseNode(selectionNode, 0);

        if (!summary || !summary.type) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'ok',
                deviceId,
                widget_type: null,
                reason: 'no-hit',
              }, null, 2),
            }],
          };
        }

        // 3. Walk parent chain (best-effort; failures do not abort).
        let ancestorChain: ReturnType<typeof toPublicShape>[] = [];
        if (summary.valueId) {
          try {
            const rawChain = await client.getParentChain({
              inspectorRef: summary.valueId,
              objectGroup,
            });
            ancestorChain = flattenParentChain(rawChain)
              .filter(isUserDefinedWidget)
              .map(toPublicShape);
          } catch (chainErr) {
            console.error(
              `[flutter_widget_at_point] getParentChain failed: ${
                chainErr instanceof Error ? chainErr.message : String(chainErr)
              }`,
            );
          }
        }

        const publicSelection = toPublicShape(summary);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              widget_type: publicSelection.widget_type,
              description: publicSelection.description,
              widget_id: publicSelection.widget_id,
              creation_location: publicSelection.creation_location,
              ancestor_chain: ancestorChain,
              view: {
                width_physical: metrics.widthPhysical,
                height_physical: metrics.heightPhysical,
                device_pixel_ratio: metrics.devicePixelRatio,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_widget_at_point] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_VM_NOT_CONNECTED, message);
      }
    },
  );
}
