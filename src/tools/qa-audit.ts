import { MCPServer, getWebKitClient } from '../mcp-server.js';

export function registerQAAuditTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_full_audit',
      description: 'Run all 13 iOS QA detectors and generate a scored report',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to audit (optional — uses current page if not set)' },
        },
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client) return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      const { QAAudit } = await import('../qa/audit.js');
      const { generateAuditMarkdown } = await import('../qa/report-markdown.js');
      const { QAHistory } = await import('../qa/history.js');
      const audit = new QAAudit(client);
      const report = await audit.runFullAudit(params.url as string | undefined);
      const markdown = generateAuditMarkdown(report);
      const history = new QAHistory();
      await history.save(report);
      return { content: [{ type: 'text' as const, text: markdown + '\n\n---\n\nJSON Report:\n```json\n' + JSON.stringify(report, null, 2) + '\n```' }] };
    },
  );
}
