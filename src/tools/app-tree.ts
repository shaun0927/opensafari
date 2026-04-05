import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  getAccessibilityTree,
  formatTreeMarkdown,
  formatTreeFlat,
} from '../native/accessibility';

/**
 * app_tree — Dump the native iOS accessibility tree
 *
 * Captures the accessibility hierarchy of the frontmost app in the simulator
 * and returns it in the requested format (json, markdown, or flat list).
 */
export function registerAppTreeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_tree',
      description:
        'Dump the native iOS accessibility tree of the frontmost app in the simulator. ' +
        'Returns the full element hierarchy with roles, labels, values, traits, and frames. ' +
        'Use this to understand the native UI structure for accessibility testing or element queries.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          format: {
            type: 'string',
            enum: ['json', 'markdown', 'flat'],
            description: 'Output format (default: json)',
          },
          maxDepth: {
            type: 'number',
            description: 'Maximum tree depth to traverse (default: 10)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = (params.deviceId as string) || getSessionManager().getActiveDeviceId() || undefined;
        const format = (params.format as string) || 'json';
        const maxDepth = (params.maxDepth as number) ?? 10;

        const tree = await getAccessibilityTree({ deviceId, maxDepth });

        let output: string;
        switch (format) {
          case 'markdown':
            output = formatTreeMarkdown(tree);
            break;
          case 'flat':
            output = formatTreeFlat(tree);
            break;
          case 'json':
          default:
            output = JSON.stringify(tree, null, 2);
            break;
        }

        return {
          content: [{ type: 'text' as const, text: output }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_tree] ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
