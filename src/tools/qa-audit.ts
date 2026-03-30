import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerQAAuditTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_full_audit',
      description: 'Run all 13 iOS QA detectors and generate a scored report',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to audit (optional — uses current page if not set)' },
          format: {
            type: 'string',
            enum: ['markdown', 'junit', 'json', 'html'],
            description: 'Report format: markdown (default), junit (JUnit XML for CI), json (structured JSON), or html (self-contained HTML)',
          },
          annotate: { type: 'boolean', description: 'Annotate screenshot with detected issue bounding boxes (default: false)' },
        },
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client) return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const { QAAudit } = await import('../qa/audit');
      const { QAHistory } = await import('../qa/history');
      const audit = new QAAudit(client);
      const report = await audit.runFullAudit(params.url as string | undefined);
      const history = new QAHistory();
      await history.save(report);

      const format = (params.format as string) ?? 'markdown';

      if (format === 'html') {
        const { saveHtmlReport } = await import('../qa/report-html');
        const filePath = await saveHtmlReport(report);
        return { content: [{ type: 'text' as const, text: `HTML report saved to: ${filePath}` }] };
      }

      if (format === 'junit') {
        const { generateAuditJUnit } = await import('../qa/report-junit');
        return { content: [{ type: 'text' as const, text: generateAuditJUnit(report) }] };
      }

      if (format === 'json') {
        const { generateAuditJSON } = await import('../qa/report-json');
        return { content: [{ type: 'text' as const, text: JSON.stringify(generateAuditJSON(report), null, 2) }] };
      }

      const { generateAuditMarkdown } = await import('../qa/report-markdown');
      const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
        { type: 'text' as const, text: generateAuditMarkdown(report) },
      ];

      if (params.annotate === true) {
        try {
          const screenshot = await client.screenshot({});
          const annotated = await audit.annotateReport(report, screenshot.toString('base64'));
          content.push(
            { type: 'text' as const, text: annotated.legend },
            { type: 'image' as const, data: annotated.annotatedScreenshot, mimeType: 'image/png' },
          );
        } catch (_e) {
          // Annotation is best-effort; continue with unannotated report
        }
      }

      return { content };
    },
  );
}
