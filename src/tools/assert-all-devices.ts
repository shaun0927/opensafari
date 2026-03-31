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
          includeScreenshot: {
            type: 'boolean',
            description: 'Capture a screenshot from each device after the assertion check',
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

      try {
        const result = await crossDeviceAssert.assertAll({
          check: params.check as AssertionCheck,
          selector: params.selector as string | undefined,
          assertion: params.assertion as string | undefined,
          expected: params.expected as string | undefined,
          includeScreenshot: params.includeScreenshot as boolean | undefined,
        });

        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        // Build summary without screenshots to avoid bloated JSON
        const summaryResult = {
          ...result,
          results: result.results.map((r: any) => {
            const { screenshot, ...rest } = r;
            return rest;
          }),
        };
        content.push({ type: 'text' as const, text: JSON.stringify(summaryResult, null, 2) });

        // Add screenshots as proper MCP image content blocks
        if (params.includeScreenshot) {
          for (const r of result.results as any[]) {
            if (r.screenshot) {
              content.push(
                { type: 'text' as const, text: `Screenshot: ${r.deviceName ?? 'unknown'}` },
                { type: 'image' as const, data: r.screenshot, mimeType: 'image/png' },
              );
            }
          }
        }

        return { content };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
