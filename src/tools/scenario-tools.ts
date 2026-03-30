import { MCPServer } from '../mcp-server';
import { ScenarioRunner, TestScenario } from '../orchestration/scenario-runner';

let runner: ScenarioRunner | null = null;

export function setScenarioRunner(r: ScenarioRunner): void {
  runner = r;
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerScenarioTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'run_scenario',
      description: 'Execute a declarative test scenario across devices with per-step, per-device results',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Scenario name' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['navigate', 'click', 'type', 'scroll', 'wait', 'assert', 'screenshot'],
                },
                target: { type: 'string', description: 'CSS selector' },
                value: { type: 'string', description: 'Input value, URL, or scroll direction' },
                assertion: { type: 'string', description: 'JS expression for assert steps' },
                devices: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Subset of device presets (default: all)',
                },
                timeout: { type: 'number', description: 'Step timeout in ms' },
              },
              required: ['action'],
            },
            description: 'Ordered list of test steps',
          },
        },
        required: ['name', 'steps'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!runner) return errorResult('Scenario runner not initialized — boot a simulator pool first');
      const scenario: TestScenario = {
        name: params.name as string,
        steps: params.steps as TestScenario['steps'],
      };
      const result = await runner.run(scenario);
      return jsonResult(result);
    },
  );
}
