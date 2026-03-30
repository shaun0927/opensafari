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
            enum: ['markdown', 'json', 'html'],
            description: 'Report format (default: markdown)',
          },
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

      if (format === 'json') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      }

      const { generateAuditMarkdown } = await import('../qa/report-markdown');
      const markdown = generateAuditMarkdown(report);
      return {
        content: [
          {
            type: 'text' as const,
            text: markdown + '\n\n---\n\nJSON Report:\n```json\n' + JSON.stringify(report, null, 2) + '\n```',
          },
        ],
      };
    },
  );
}
