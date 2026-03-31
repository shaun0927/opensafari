import { MCPServer } from '../mcp-server';
import { HybridQAEngine } from '../orchestration/hybrid-qa';

let engine: HybridQAEngine | null = null;

export function setHybridQAEngine(e: HybridQAEngine): void {
  engine = e;
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerHybridQATools(server: MCPServer): void {
  // ── hybrid_qa_start ──
  server.registerTool(
    {
      name: 'hybrid_qa_start',
      description: 'Start a hybrid two-phase QA workflow. Phase A: fast scan with viewport emulation + multi-tab. Phase B: deep verify on real devices (sequential, only for flagged issues).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'URLs to test' },
          devices: { type: 'array', items: { type: 'string' }, description: 'Device presets to simulate (e.g. ["iphone-17","ipad-pro","iphone-se"])' },
          detectors: { type: 'array', items: { type: 'string' }, description: 'QA detector names to run (default: all)' },
          deepVerifyThreshold: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Minimum severity to trigger Phase B deep verification (default: medium)' },
          skipPhaseB: { type: 'boolean', description: 'Skip Phase B and only run fast scan (default: false)' },
          authProfile: { type: 'string', description: 'Auth profile to inject' },
        },
        required: ['urls', 'devices'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Hybrid QA engine not initialized');
      try {
        const result = await engine.start(params as any);
        return jsonResult(result);
      } catch (err) {
        return errorResult(`Hybrid QA failed: ${err}`);
      }
    },
  );

  // ── hybrid_qa_status ──
  server.registerTool(
    {
      name: 'hybrid_qa_status',
      description: 'Check the status of a running hybrid QA workflow.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Hybrid QA workflow ID' },
        },
        required: ['id'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Hybrid QA engine not initialized');
      const result = engine.getStatus(params.id as string);
      if (!result) return errorResult(`Workflow not found: ${params.id}`);
      return jsonResult({
        id: result.id,
        status: result.status,
        phaseA: {
          duration: result.phaseA.duration,
          scansCompleted: result.phaseA.scans.length,
          totalIssues: result.phaseA.totalIssues,
          flaggedForVerification: result.phaseA.flaggedForVerification,
        },
        phaseB: result.phaseB ? {
          duration: result.phaseB.duration,
          confirmedCount: result.phaseB.confirmedCount,
          falsePositiveCount: result.phaseB.falsePositiveCount,
        } : null,
        totalDuration: result.totalDuration,
        peakMode: result.peakMode,
      });
    },
  );

  // ── hybrid_qa_results ──
  server.registerTool(
    {
      name: 'hybrid_qa_results',
      description: 'Get full results of a completed hybrid QA workflow with confirmed/false-positive classification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Hybrid QA workflow ID' },
        },
        required: ['id'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!engine) return errorResult('Hybrid QA engine not initialized');
      const result = engine.getResults(params.id as string);
      if (!result) return errorResult(`Workflow not found: ${params.id}`);
      return jsonResult(result);
    },
  );
}
