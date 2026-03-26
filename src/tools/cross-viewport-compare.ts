import { MCPServer } from '../mcp-server';
import { formatForClaudeVision, MCPContent } from '../comparison/report';

let capturer: any = null;
export function setCrossViewportCapture(c: any): void { capturer = c; }

export function registerCrossViewportCompareTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'cross_viewport_compare',
      description: 'Capture the same page across all active simulators for visual comparison. Returns screenshots with device/viewport/breakpoint metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to capture on all devices' },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          settleTime: { type: 'number', description: 'Ms to wait after load for dynamic content' },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!capturer) return { content: [{ type: 'text' as const, text: 'Error: Cross-viewport capture not initialized' }], isError: true };
      const captures = await capturer.capture(params.url as string, {
        waitUntil: params.waitUntil as any,
        settleTime: params.settleTime as number | undefined,
      });
      const content = formatForClaudeVision(captures);
      return { content: content.map((c: MCPContent) => ({ type: (c.type ?? 'text') as 'text', text: c.text, ...(c.data ? { data: c.data, mimeType: c.mimeType } : {}) })) };
    },
  );
}
