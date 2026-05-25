export type HighRiskToolCategory = 'code-execution' | 'credential-movement';

export interface HighRiskToolMetadata {
  category: HighRiskToolCategory;
  requiredCapability: 'http-high-risk-tools';
}

export const HTTP_HIGH_RISK_TOOL_CAPABILITY = 'http-high-risk-tools' as const;
export const HTTP_HIGH_RISK_TOOLS_ENV = 'OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS' as const;
export const HTTP_HIGH_RISK_TOOLS_FLAG = '--http-enable-high-risk-tools' as const;

export const HIGH_RISK_MCP_TOOLS: Readonly<Record<string, HighRiskToolMetadata>> = Object.freeze({
  javascript: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  // batch_execute fans out an arbitrary JS expression to every active simulator
  // (src/tools/batch-execute.ts), so it is a code-execution surface equivalent to `javascript`.
  batch_execute: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  flutter_evaluate: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  // flutter_call_service_extension explicitly documents itself as accepting
  // arbitrary VM-service extension code in `args` and must be treated like flutter_evaluate
  // (src/tools/flutter-service-extensions.ts).
  flutter_call_service_extension: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  // run_scenario evaluates a caller-supplied JS `assertion` in the page context
  // (src/tools/scenario-tools.ts), so it can run arbitrary code in HTTP mode.
  run_scenario: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  // assert_all_devices accepts a JS `assertion` for the "custom" check
  // (src/tools/assert-all-devices.ts), executed in the page context across all devices.
  assert_all_devices: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  // mock_geolocation interpolates `latitude`/`longitude`/`accuracy`/`altitude` directly into
  // a JS template that is then run via `client.evaluate` (src/tools/mock-geolocation.ts).
  // MCP does not enforce JSON Schema at runtime, so a string payload that survives the numeric
  // range check (e.g. NaN-on-coercion) yields arbitrary code execution in the page context.
  mock_geolocation: {
    category: 'code-execution',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  auth_save: {
    category: 'credential-movement',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  auth_restore: {
    category: 'credential-movement',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  app_biometric: {
    category: 'credential-movement',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
  cookies: {
    category: 'credential-movement',
    requiredCapability: HTTP_HIGH_RISK_TOOL_CAPABILITY,
  },
});

export function getHighRiskToolMetadata(toolName: string): HighRiskToolMetadata | undefined {
  return HIGH_RISK_MCP_TOOLS[toolName];
}

export function parseHttpHighRiskToolsEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function buildHttpHighRiskToolError(toolName: string): string {
  return `HTTP high-risk tool "${toolName}" requires ${HTTP_HIGH_RISK_TOOLS_FLAG} or ${HTTP_HIGH_RISK_TOOLS_ENV}=1. Stdio mode is unchanged.`;
}
