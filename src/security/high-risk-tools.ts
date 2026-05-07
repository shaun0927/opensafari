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
  flutter_evaluate: {
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
