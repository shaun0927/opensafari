import { MCPServer } from '../mcp-server';
import { SimulatorWorkflowEngine } from '../orchestration/workflow-engine';

let engine: SimulatorWorkflowEngine | null = null;

export function setWorkflowEngine(e: SimulatorWorkflowEngine): void {
  engine = e;
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerOrchestrationTools(server: MCPServer): void {
  // ── workflow_init ──────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'workflow_init',
      description: 'Initialize a multi-device QA workflow. Boots simulators, injects auth, and returns per-worker prompts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          devices: { type: 'array', items: { type: 'string' }, description: 'Device preset names (e.g. ["iphone-17","ipad-pro"])' },
          url: { type: 'string', description: 'URL to navigate all devices to' },
          authProfile: { type: 'string', description: 'Auth profile name to inject' },
          taskDescription: { type: 'string', description: 'Task description for worker prompts' },
          workerNames: { type: 'array', items: { type: 'string' }, description: 'Custom worker names' },
          mode: { type: 'string', enum: ['concurrent', 'sequential'], description: 'Execution mode: concurrent (all at once, high RAM) or sequential (one at a time, low RAM). Default: concurrent' },
        },
        required: ['devices'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      const result = await engine.initWorkflow(params as any);
      return jsonResult(result);
    },
  );

  // ── workflow_status ────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'workflow_status',
      description: 'Get the current status of a running workflow including per-worker progress.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID returned by workflow_init' },
        },
        required: ['workflowId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      const result = engine.getStatus(params.workflowId as string);
      return jsonResult(result);
    },
  );

  // ── workflow_collect ───────────────────────────────────────────────
  server.registerTool(
    {
      name: 'workflow_collect',
      description: 'Collect final results from all workers in a completed workflow.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID' },
        },
        required: ['workflowId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      const result = engine.collectResults(params.workflowId as string);
      return jsonResult(result);
    },
  );

  // ── workflow_collect_partial ───────────────────────────────────────
  server.registerTool(
    {
      name: 'workflow_collect_partial',
      description: 'Collect results from completed/failed workers only (workflow may still be running).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID' },
        },
        required: ['workflowId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      const result = engine.collectPartialResults(params.workflowId as string);
      return jsonResult(result);
    },
  );

  // ── workflow_cleanup ───────────────────────────────────────────────
  server.registerTool(
    {
      name: 'workflow_cleanup',
      description: 'Clean up a workflow: remove state and shut down all simulators.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID' },
        },
        required: ['workflowId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      await engine.cleanupWorkflow(params.workflowId as string);
      return jsonResult({ success: true, message: 'Workflow cleaned up and simulators shut down' });
    },
  );

  // ── worker_update ──────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'worker_update',
      description: 'Report progress from a worker. Updates the worker status to active.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID' },
          workerName: { type: 'string', description: 'Worker name' },
          update: { type: 'string', description: 'Progress update message' },
        },
        required: ['workflowId', 'workerName', 'update'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      await engine.updateWorker(
        params.workflowId as string,
        params.workerName as string,
        params.update as string,
      );
      return jsonResult({ success: true });
    },
  );

  // ── worker_complete ────────────────────────────────────────────────
  server.registerTool(
    {
      name: 'worker_complete',
      description: 'Mark a worker as completed with its final results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string', description: 'Workflow ID' },
          workerName: { type: 'string', description: 'Worker name' },
          results: { type: 'object', description: 'Final results object from the worker' },
        },
        required: ['workflowId', 'workerName', 'results'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Workflow engine not initialized');
      await engine.completeWorker(
        params.workflowId as string,
        params.workerName as string,
        params.results,
      );
      return jsonResult({ success: true });
    },
  );
}
