import { MCPServer } from '../mcp-server';
import { StepBarrier } from '../orchestration/step-barrier';

let barrier: StepBarrier = new StepBarrier();

export function setBarrier(b: StepBarrier): void {
  barrier = b;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerBarrierTools(server: MCPServer): void {
  // ── barrier_wait ────────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'barrier_wait',
      description:
        'Wait at a named synchronization barrier until all specified devices arrive. ' +
        'Used to coordinate multi-device test steps (e.g. ensure both devices loaded a page before proceeding).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          stepName: { type: 'string', description: 'Name of the synchronization step' },
          deviceId: { type: 'string', description: 'Current device identifier' },
          allDeviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'All device IDs that must synchronize at this step',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default 30000)',
          },
        },
        required: ['stepName', 'deviceId', 'allDeviceIds'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const stepName = params.stepName as string;
      const deviceId = params.deviceId as string;
      const allDeviceIds = params.allDeviceIds as string[];
      const timeout = params.timeout as number | undefined;
      const result = await barrier.wait(stepName, deviceId, allDeviceIds, { timeout });
      return jsonResult(result);
    },
  );

  // ── barrier_status ──────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'barrier_status',
      description: 'Get the current status of a named synchronization barrier.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          stepName: { type: 'string', description: 'Name of the synchronization step' },
        },
        required: ['stepName'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const status = barrier.getStatus(params.stepName as string);
      if (!status) {
        return jsonResult({ message: 'No active barrier for this step' });
      }
      return jsonResult(status);
    },
  );

  // ── barrier_clear ───────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'barrier_clear',
      description: 'Clear a specific synchronization barrier, or all barriers if no stepName given.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          stepName: {
            type: 'string',
            description: 'Name of the barrier to clear. Omit to clear all barriers.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (params.stepName) {
        barrier.clear(params.stepName as string);
        return jsonResult({ success: true, message: `Barrier "${params.stepName}" cleared` });
      }
      barrier.clearAll();
      return jsonResult({ success: true, message: 'All barriers cleared' });
    },
  );
}
