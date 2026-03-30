import { MCPServer } from '../mcp-server';
import { CrossDeviceAssert, AssertionCheck } from '../orchestration/cross-device-assert';

let crossDeviceAssert: CrossDeviceAssert | null = null;

export function setCrossDeviceAssert(a: CrossDeviceAssert): void {
  crossDeviceAssert = a;
}

export function registerAssertAllDevicesTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'assert_all_devices',
      description: 'Assert a condition across all active devices simultaneously',
      inputSchema: {
        type: 'object' as const,
        properties: {
          check: {
            type: 'string',
            enum: ['visible', 'exists', 'text_matches', 'custom'],
            description: 'Type of assertion check',
          },
          selector: {
            type: 'string',
            description: 'CSS selector to check',
          },
          assertion: {
            type: 'string',
            description: 'JavaScript expression (for custom check)',
          },
          expected: {
            type: 'string',
            description: 'Expected text content (for text_matches check)',
          },
        },
        required: ['check'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!crossDeviceAssert) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No simulator pool active' }],
          isError: true,
        };
      }

      const result = await crossDeviceAssert.assertAll({
        check: params.check as AssertionCheck,
        selector: params.selector as string | undefined,
        assertion: params.assertion as string | undefined,
        expected: params.expected as string | undefined,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
