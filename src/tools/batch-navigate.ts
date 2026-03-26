import { MCPServer } from '../mcp-server';
import { BatchExecutor } from '../simulator/batch';

let batchExecutor: BatchExecutor | null = null;

export function setBatchExecutor(executor: BatchExecutor): void {
  batchExecutor = executor;
}

export function registerBatchNavigateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'batch_navigate',
      description: 'Navigate all active simulators to the same URL simultaneously',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!batchExecutor) return { content: [{ type: 'text' as const, text: 'Error: No simulator pool active' }], isError: true };
      const results = await batchExecutor.batchNavigate(params.url as string, params.waitUntil as any);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );
}
