import { MCPServer } from '../mcp-server';
import { ScenarioRunner, TestScenario } from '../orchestration/scenario-runner';
import { ErrorCode, respondWithStructuredError } from '../errors';

let runner: ScenarioRunner | null = null;

export function setScenarioRunner(r: ScenarioRunner): void {
  runner = r;
}

function errorResult(msg: string, code = ErrorCode.APP_STATE_UNKNOWN) {
  return respondWithStructuredError(code, msg);
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerScenarioTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'run_scenario',
      description: 'Execute a declarative test scenario across devices with per-step, per-device results. Mobile semantic v2 navigation is postcondition-first: action-specific required fields are enforced in the schema before runtime execution; gotoScreen accepts query, settle.query, or context=flutter plus target route and never succeeds on deeplink dispatch alone.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Scenario name' },
          version: { type: 'number', enum: [1, 2], description: 'Scenario schema version. Version 2 enables mobile semantic steps.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: [
                    'navigate', 'click', 'type', 'scroll', 'wait', 'assert', 'screenshot',
                    'recordState', 'launchApp', 'gotoScreen', 'tapElement', 'typeElement',
                    'waitFor', 'assertElement', 'popUntil', 'dismissOverlay', 'collectDebugBundle',
                  ],
                },
                target: { type: 'string', description: 'CSS selector for browser v1 steps. For v2 gotoScreen with context=flutter, target may be a Flutter route postcondition.' },
                value: { type: 'string', description: 'Input value, URL, or scroll direction. Required for typeElement. For v2 gotoScreen this is an optional deeplink transport; query, settle.query, or context=flutter plus target route is still required as the postcondition.' },
                assertion: { type: 'string', description: 'JS expression evaluated in the page context (same as javascript tool). Returns boolean.' },
                bundleId: { type: 'string', description: 'Bundle id for mobile v2 launchApp' },
                expectedBundleId: { type: 'string', description: 'Expected app bundle for state snapshots and post-step verification' },
                context: { type: 'string', enum: ['native', 'webview', 'safari', 'flutter'] },
                mode: { type: 'string', enum: ['auto', 'drawer', 'bottom_sheet', 'dialog'], description: 'Overlay mode for dismissOverlay.' },
                allowNativeFallback: { type: 'boolean', description: 'Allow bounded native fallback for gotoScreen.' },
                nativeFallbackQueries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      identifier: { type: 'string' },
                      label: { type: 'string' },
                      text: { type: 'string' },
                      role: { type: 'string' },
                    },
                  },
                },
                maxNativeAttempts: { type: 'number', description: 'Bounded max attempts for native mobile actions.' },
                query: {
                  type: 'object',
                  description: 'AX query for mobile v2 tap/type/wait/assert steps. Required for tapElement and typeElement as the target selector; gotoScreen, waitFor, and assertElement require query unless settle.query is supplied. Mutating tap/type steps also require settle.query as the success postcondition.',
                  properties: {
                    identifier: { type: 'string' },
                    label: { type: 'string' },
                    text: { type: 'string' },
                    role: { type: 'string' },
                  },
                },
                condition: { type: 'string', enum: ['exists', 'not_exists', 'visible', 'enabled'] },
                settle: {
                  type: 'object',
                  description: 'Shared settle/postcondition policy for mobile v2 steps. For gotoScreen, provide settle.query here, query at the step root, or context=flutter plus target route; transport-only gotoScreen is invalid.',
                  properties: {
                    query: {
                      type: 'object',
                      properties: {
                        identifier: { type: 'string' },
                        label: { type: 'string' },
                        text: { type: 'string' },
                        role: { type: 'string' },
                      },
                    },
                    condition: { type: 'string', enum: ['exists', 'not_exists', 'visible', 'enabled'] },
                    timeoutMs: { type: 'number' },
                    intervalMs: { type: 'number' },
                    stableMs: { type: 'number' },
                    allowTransientErrors: { type: 'boolean' },
                    maxRecoverableRetries: { type: 'number' },
                  },
                },
                devices: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Subset of device presets (default: all)',
                },
                timeout: { type: 'number', description: 'Step timeout in ms' },
              },
              required: ['action'],
              allOf: [
                {
                  if: { properties: { action: { const: 'gotoScreen' } }, required: ['action'] },
                  then: {
                    anyOf: [
                      { required: ['query'] },
                      {
                        required: ['settle'],
                        properties: { settle: { required: ['query'] } },
                      },
                      {
                        required: ['context', 'target'],
                        properties: { context: { const: 'flutter' } },
                      },
                    ],
                  },
                },
                {
                  if: { properties: { action: { const: 'launchApp' } }, required: ['action'] },
                  then: { required: ['bundleId'] },
                },
                {
                  if: { properties: { action: { const: 'tapElement' } }, required: ['action'] },
                  then: {
                    required: ['query', 'settle'],
                    properties: { settle: { required: ['query'] } },
                  },
                },
                {
                  if: { properties: { action: { const: 'typeElement' } }, required: ['action'] },
                  then: {
                    required: ['query', 'value', 'settle'],
                    properties: { settle: { required: ['query'] } },
                  },
                },
                {
                  if: { properties: { action: { const: 'waitFor' } }, required: ['action'] },
                  then: {
                    anyOf: [
                      { required: ['query'] },
                      {
                        required: ['settle'],
                        properties: { settle: { required: ['query'] } },
                      },
                    ],
                  },
                },
                {
                  if: { properties: { action: { const: 'assertElement' } }, required: ['action'] },
                  then: {
                    anyOf: [
                      { required: ['query'] },
                      {
                        required: ['settle'],
                        properties: { settle: { required: ['query'] } },
                      },
                    ],
                  },
                },

                {
                  if: { properties: { action: { const: 'popUntil' } }, required: ['action'] },
                  then: {
                    anyOf: [
                      { required: ['query'] },
                      {
                        required: ['settle'],
                        properties: { settle: { required: ['query'] } },
                      },
                    ],
                  },
                },
                {
                  if: { properties: { action: { const: 'dismissOverlay' } }, required: ['action'] },
                  then: {
                    anyOf: [
                      { required: ['query'] },
                      {
                        required: ['settle'],
                        properties: { settle: { required: ['query'] } },
                      },
                    ],
                  },
                },
              ],
            },
            description: 'Ordered list of test steps',
          },
        },
        required: ['name', 'steps'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!runner) return errorResult('Scenario runner not initialized — boot a simulator pool first');
      if (!Array.isArray(params.steps)) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'steps must be an array');
      }
      const scenario: TestScenario = {
        name: params.name as string,
        steps: params.steps as TestScenario['steps'],
        version: params.version as TestScenario['version'],
      };
      const result = await runner.run(scenario);
      return jsonResult(result);
    },
  );
}
