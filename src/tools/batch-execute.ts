import { MCPServer } from '../mcp-server';
import { BatchExecutor } from '../simulator/batch';
import { ErrorCode, respondWithStructuredError } from '../errors';

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
      if (!batchExecutor) return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No simulator pool active');
      const results = await batchExecutor.batchExecute(params.expression as string);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );
}
