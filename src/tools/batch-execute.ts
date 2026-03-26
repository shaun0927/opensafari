import { MCPServer } from '../mcp-server';
import { BatchExecutor } from '../simulator/batch';

let batchExecutor: BatchExecutor | null = null;

export function setBatchExecutor(executor: BatchExecutor): void {
  batchExecutor = executor;
}

export function registerBatchExecuteTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'batch_execute',
      description: 'Execute a JavaScript expression on all active simulators simultaneously',
      inputSchema: {
        type: 'object' as const,
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        },
        required: ['expression'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!batchExecutor) return { content: [{ type: 'text' as const, text: 'Error: No simulator pool active' }], isError: true };
      const results = await batchExecutor.batchExecute(params.expression as string);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );
}
