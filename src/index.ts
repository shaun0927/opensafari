// OpenSafari MCP Server — Public API
// iOS Safari automation via Xcode Simulator + WebKit Remote Debugging Protocol

import { MCPServer } from './mcp-server';
import { registerAllTools } from './tools';

// Core server
export { MCPServer, getWebKitClient, setWebKitClient } from './mcp-server';
export type { MCPServerOptions } from './mcp-server';

// Tool registration
export { registerAllTools, setWorkflowEngine, setCrossViewportCapture, setScenarioRunner, setBarrier, setCrossDeviceAssert } from './tools';

// WebKit client
export { WebKitClient } from './webkit/client';
export type { WebKitClientOptions, WebKitTarget } from './webkit/client';

// Simulator
export { SimulatorManager } from './simulator';
export { SimulatorPool } from './simulator/pool';
export type { PooledSimulator, SimulatorPoolOptions } from './simulator/pool';
export { WebInspectorProxy, getSharedProxy } from './simulator/proxy';
export type { ProxyOptions } from './simulator/proxy';
export { DEVICE_PRESETS } from './simulator/presets';

// Auth
export { AuthManager } from './auth';
export type { AuthProfile, ExpiryInfo } from './auth';

// Orchestration
export { SimulatorWorkflowEngine } from './orchestration/workflow-engine';
export { ScenarioRunner } from './orchestration/scenario-runner';
export { CrossViewportCapture } from './comparison/cross-viewport';

// Configuration
export { getGlobalConfig, setGlobalConfig, resetGlobalConfig } from './config/global';
export type { OpenSafariConfig } from './config/global';

// Types
export type { BrowserBackend, NavigateOptions, NavigateResult, ElementInfo, Cookie } from './types/browser-backend';

// Convenience factory
export async function createServer(options?: {
  transport?: 'stdio' | 'http';
  port?: number;
  allTools?: boolean;
}): Promise<MCPServer> {
  const server = new MCPServer();
  registerAllTools(server);
  if (options?.allTools) server.setTier(3);
  await server.start({
    transport: options?.transport ?? 'stdio',
    port: options?.port,
  });
  return server;
}
