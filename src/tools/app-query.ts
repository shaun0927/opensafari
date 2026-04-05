import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { queryAccessibilityTree, QueryMatch } from '../native/accessibility';

/**
 * app_query — Query native elements by semantic selectors
 *
 * Searches the accessibility tree for nodes matching the given strategy
 * and selector value. Returns matched elements with hierarchy paths.
 */
export function registerAppQueryTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_query',
      description:
        'Query native iOS accessibility elements by semantic selectors. ' +
        'Supports querying by accessibility ID, label text, role, text content, ' +
        'or predicate expressions (e.g. "role=Button AND label=Submit").',
      inputSchema: {
        type: 'object' as const,
        properties: {
          selector: {
            type: 'string',
            description:
              'Search value (accessibility ID, label text, role name, or predicate expression)',
          },
          strategy: {
            type: 'string',
            enum: ['accessibilityId', 'label', 'text', 'role', 'predicate'],
            description: 'Query strategy (default: label)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['selector'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const selector = params.selector as string;
        const strategy = (params.strategy as string) || 'label';
        const deviceId = (params.deviceId as string) || getSessionManager().getActiveDeviceId() || undefined;

        const validStrategies = ['accessibilityId', 'label', 'text', 'role', 'predicate'];
        if (!validStrategies.includes(strategy)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Invalid strategy "${strategy}". Must be one of: ${validStrategies.join(', ')}`,
            }],
            isError: true,
          };
        }

        const matches = await queryAccessibilityTree(
          {
            strategy: strategy as 'accessibilityId' | 'label' | 'text' | 'role' | 'predicate',
            value: selector,
            deviceId,
          },
        );

        if (matches.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                matches: [],
                count: 0,
                message: `No elements found matching ${strategy}="${selector}". ` +
                  'Try a different strategy or a broader selector. ' +
                  'Use app_tree to see the full accessibility hierarchy.',
              }),
            }],
            isError: true,
          };
        }

        const result = formatMatches(matches);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_query] ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

function formatMatches(matches: QueryMatch[]): {
  matches: Array<{
    role: string;
    label?: string;
    value?: string;
    identifier?: string;
    traits: string[];
    frame: { x: number; y: number; width: number; height: number };
    isVisible: boolean;
    isEnabled: boolean;
    path: string;
    depth: number;
  }>;
  count: number;
} {
  return {
    matches: matches.map(m => ({
      role: m.node.role,
      label: m.node.label,
      value: m.node.value,
      identifier: m.node.identifier,
      traits: m.node.traits,
      frame: m.node.frame,
      isVisible: m.node.isVisible,
      isEnabled: m.node.isEnabled,
      path: m.path,
      depth: m.depth,
    })),
    count: matches.length,
  };
}
