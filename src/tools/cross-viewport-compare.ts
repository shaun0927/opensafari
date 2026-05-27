import { MCPServer } from '../mcp-server';
import { formatForClaudeVision, MCPContent } from '../comparison/report';
import { ErrorCode, respondWithStructuredError } from '../errors';

let capturer: any = null;
export function setCrossViewportCapture(c: any): void {
  capturer = c;
}

export function registerCrossViewportCompareTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'cross_viewport_compare',
      description:
        'Capture the same page across all active simulators for visual comparison. Returns screenshots with device/viewport/breakpoint metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to capture on all devices' },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          settleTime: { type: 'number', description: 'Ms to wait after load for dynamic content' },
          format: { type: 'string', enum: ['default', 'html'], description: 'Output format (default: vision-optimized)' },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!capturer)
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, 'Cross-viewport capture not initialized');
      const captures = await capturer.capture(params.url as string, {
        waitUntil: params.waitUntil as any,
        settleTime: params.settleTime as number | undefined,
      });

      if (params.format === 'html') {
        const fsPromises = await import('fs/promises');
        const pathMod = await import('path');
        const osMod = await import('os');
        const { generateComparisonHtml } = await import('../qa/report-html');

        const deviceCaptures = captures.map((cap: any) => ({
          device: String(cap.device ?? 'Unknown'),
          viewport: { w: cap.viewport?.w ?? 0, h: cap.viewport?.h ?? 0 },
          screenshot: cap.screenshot,
        }));

        const html = generateComparisonHtml(String(params.url), deviceCaptures);

        const outputDir = pathMod.join(osMod.homedir(), '.opensafari', 'reports', 'html');
        await fsPromises.mkdir(outputDir, { recursive: true });
        const filename = `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
        const filePath = pathMod.join(outputDir, filename);
        await fsPromises.writeFile(filePath, html, 'utf-8');

        return { content: [{ type: 'text' as const, text: `HTML comparison report saved to: ${filePath}` }] };
      }

      const content = formatForClaudeVision(captures);
      return {
        content: content.map((c: MCPContent) => ({
          type: (c.type ?? 'text') as 'text',
          text: c.text,
          ...(c.data ? { data: c.data, mimeType: c.mimeType } : {}),
        })),
      };
    },
  );
}
