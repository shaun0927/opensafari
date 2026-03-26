import { MCPServer } from '../mcp-server';
import { BatchExecutor } from '../simulator/batch';

let batchExecutor: BatchExecutor | null = null;

export function setBatchExecutor(executor: BatchExecutor): void {
  batchExecutor = executor;
}

export function registerBatchScreenshotTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'batch_screenshot',
      description: 'Take a screenshot on all active simulators simultaneously',
      inputSchema: {
        type: 'object' as const,
        properties: {
          format: { type: 'string', enum: ['png'], description: 'Image format' },
          fullPage: { type: 'boolean', description: 'Capture full page' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!batchExecutor) return { content: [{ type: 'text' as const, text: 'Error: No simulator pool active' }], isError: true };
      const results = await batchExecutor.batchScreenshot({ format: params.format as 'png' | undefined, fullPage: params.fullPage as boolean | undefined });
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );
}
