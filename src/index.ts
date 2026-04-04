// OpenSafari MCP Server — Public API
// iOS Safari automation via Xcode Simulator + WebKit Remote Debugging Protocol

import { MCPServer } from './mcp-server';
import { registerAllTools } from './tools';

// Core server
export { MCPServer, getWebKitClient, setWebKitClient } from './mcp-server';
export { getSessionManager, SessionManager } from './session-manager';
export type { SimulatorInfo, WorkerInfo } from './session-manager';
export type { MCPServerOptions } from './mcp-server';

// Tool registration
export { registerAllTools, setWorkflowEngine, setCrossViewportCapture, setScenarioRunner, setBarrier, setCrossDeviceAssert, setCompareDevicesCapture, setCompareDevicesBatchExecutor, setHybridQAEngine } from './tools';

// Hybrid QA
export { HybridQAEngine } from './orchestration/hybrid-qa';
export type { HybridQAOptions, HybridQAResult, PageScanResult, VerifiedIssue } from './orchestration/hybrid-qa';

// WebKit client
export { WebKitClient } from './webkit/client';
export type { WebKitClientOptions, WebKitTarget } from './webkit/client';

// Simulator
export { SimulatorManager } from './simulator';
export { SimulatorPool } from './simulator/pool';
export { TabPool } from './simulator/tab-pool';
export type { TabInfo, TabPoolOptions } from './simulator/tab-pool';
export { TabClient } from './simulator/tab-client';
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

// Comparison Engines
export { VisualDiffEngine } from './comparison/visual-diff';
export type { VisualDiffOptions, VisualDiffResult, PairwiseComparisonMatrix, BoundingBox } from './comparison/visual-diff';
export { DOMDiffEngine, DOM_SNAPSHOT_SCRIPT } from './comparison/dom-diff';
export type { DOMDiffOptions, DOMDiffResult, DOMDifference, DOMSnapshot, DOMElementSnapshot } from './comparison/dom-diff';

// Configuration
export { getGlobalConfig, setGlobalConfig, resetGlobalConfig } from './config/global';
export type { OpenSafariConfig } from './config/global';

// Types
export type { BrowserBackend, NavigateOptions, NavigateResult, ElementInfo, Cookie } from './types/browser-backend';

// Native app backend (stub)
export { NativeAppClient } from './native-app/client';
export type { NativeAppBackend, AccessibilityElement, AppInfo } from './types/native-app-backend';
export type { AutomationBackend, AutomationBackendBase, BackendType } from './types/automation-backend';

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
