/**
 * flutter_widget_tree — Dump the Flutter widget, render, or semantics tree.
 *
 * Requires an active flutter_connect session. Uses Dart VM Service
 * extensions to dump the full tree structure.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError } from '../errors';

export function registerFlutterWidgetTreeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_widget_tree',
      description:
        'Dump the Flutter widget tree, render tree, or semantics tree via Dart VM Service. ' +
        'Requires an active flutter_connect session. Provides full widget hierarchy not visible ' +
        'through the macOS accessibility bridge.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tree_type: {
            type: 'string',
            enum: ['widget', 'render', 'semantics'],
            description: 'Which tree to dump (default: "widget")',
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
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        const treeType = (params.tree_type as string | undefined) ?? 'widget';

        let treeDump: string;
        switch (treeType) {
          case 'widget':
            treeDump = await client.getWidgetTree();
            break;
          case 'render':
            treeDump = await client.getRenderTree();
            break;
          case 'semantics':
            treeDump = await client.getSemanticsTree();
            break;
          default:
            throw new Error(`Unknown tree type: ${treeType}. Use "widget", "render", or "semantics".`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              tree_type: treeType,
              deviceId,
              dump: treeDump,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_widget_tree] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_VM_NOT_CONNECTED, message);
      }
    },
  );
}
