import { MCPServer } from '../mcp-server';
import { registerNavigateTool } from './navigate';
import { registerScreenshotTool } from './screenshot';
import { registerJavascriptTool } from './javascript';
import { registerReadPageTool } from './read-page';
import { registerClickTool } from './click';
import { registerTypeTool } from './type';
import { registerScrollTool } from './scroll';
import { registerQueryDomTool } from './query-dom';
import { registerCookiesTool } from './cookies';
import { registerDeviceBootTool } from './device-boot';
import { registerDeviceShutdownTool } from './device-shutdown';
import { registerInspectTool } from './inspect';
import { registerWaitForTool } from './wait-for';
import { registerLongPressTool } from './long-press';
import { registerSwipeTool } from './swipe';
import { registerPressTool } from './press';
import { registerDismissKeyboardTool } from './dismiss-keyboard';
import { registerSelectOptionTool } from './select-option';
import { registerDeviceListTool } from './device-list';
import { registerDeviceRotateTool } from './device-rotate';
import { registerAppearanceToggleTool } from './appearance-toggle';
import { registerBatchNavigateTool } from './batch-navigate';
import { registerBatchScreenshotTool } from './batch-screenshot';
import { registerBatchExecuteTool } from './batch-execute';
import { registerOrchestrationTools } from './orchestration-tools';
import { registerCrossViewportCompareTool } from './cross-viewport-compare';
import { registerCompareDevicesTool } from './compare-devices';
import { registerQADetectorTools } from './qa-detectors';
import { registerQAAuditTools } from './qa-audit';
import { registerAuthTools } from './auth';
import { registerMockGeolocationTool } from './mock-geolocation';
import { registerNetworkThrottleTool } from './network-throttle';
import { registerErrorLogTool } from './error-log';
import { registerConsoleLogTool } from './console-log';
import { registerNetworkLogTool } from './network-log';
import { registerScenarioTools } from './scenario-tools';
import { registerBarrierTools } from './barrier-tools';
import { registerAssertAllDevicesTool } from './assert-all-devices';
import { registerPerformanceAuditTool } from './performance-audit';
import { registerNetworkHarTool } from './network-har';
import { registerMockPermissionTool } from './mock-permission';
import { registerNetworkInterceptTool } from './network-intercept';
import { registerNetworkOfflineTool } from './network-offline';
import { registerHybridQATools } from './hybrid-qa-tools';
import { registerAppPermissionTools } from './app-permission';

export { setWorkflowEngine } from './orchestration-tools';
export { setBarrier } from './barrier-tools';
export { setCrossViewportCapture } from './cross-viewport-compare';
export { setCompareDevicesCapture, setCompareDevicesBatchExecutor } from './compare-devices';
export { setBatchExecutor as setBatchNavigateExecutor } from './batch-navigate';
export { setBatchExecutor as setBatchScreenshotExecutor } from './batch-screenshot';
export { setBatchExecutor as setBatchExecuteExecutor } from './batch-execute';
export { setScenarioRunner } from './scenario-tools';
export { setCrossDeviceAssert } from './assert-all-devices';
export { setHybridQAEngine } from './hybrid-qa-tools';

export function registerAllTools(server: MCPServer): void {
  // Tier 1: Core
  registerNavigateTool(server);
  registerScreenshotTool(server);
  registerJavascriptTool(server);
  registerReadPageTool(server);
  registerClickTool(server);
  registerTypeTool(server);
  registerScrollTool(server);
  registerQueryDomTool(server);
  registerCookiesTool(server);
  registerDeviceBootTool(server);
  registerDeviceShutdownTool(server);

  // Tier 2: Advanced
  registerInspectTool(server);
  registerWaitForTool(server);
  registerLongPressTool(server);
  registerSwipeTool(server);
  registerPressTool(server);
  registerDismissKeyboardTool(server);
  registerSelectOptionTool(server);
  registerDeviceListTool(server);
  registerDeviceRotateTool(server);
  registerAppearanceToggleTool(server);

  // Tier 2: Device Mocking
  registerMockGeolocationTool(server);

  // Tier 2: Event Monitoring
  registerErrorLogTool(server);
  registerConsoleLogTool(server);
  // Tier 2: Event Monitoring
  registerNetworkLogTool(server);
  registerMockPermissionTool(server);

  // Tier 3: Batch Operations
  registerBatchNavigateTool(server);
  registerBatchScreenshotTool(server);
  registerBatchExecuteTool(server);

  // Tier 3: Orchestration (Workflow & Worker lifecycle)
  registerOrchestrationTools(server);

  // Tier 3: Cross-Viewport Comparison
  registerCrossViewportCompareTool(server);

  // Tier 3: Cross-Device Visual + DOM Comparison
  registerCompareDevicesTool(server);

  // Tier 3: QA Detectors
  registerQADetectorTools(server);

  // Tier 3: QA Full Audit (Score + History)
  registerQAAuditTools(server);

  // Tier 3: Auth Persistence
  registerAuthTools(server);

  // Tier 2: Network Throttle
  registerNetworkThrottleTool(server);
  // Tier 3: Scenario Runner
  registerScenarioTools(server);
  // Tier 3: Step Synchronization Barriers
  registerBarrierTools(server);
  // Tier 3: Cross-Device Assertions
  registerAssertAllDevicesTool(server);
  // Tier 3: Performance Audit
  registerPerformanceAuditTool(server);
  // Tier 3: Network HAR Export
  registerNetworkHarTool(server);
  // Tier 2: Network Interception
  registerNetworkInterceptTool(server);
  registerNetworkOfflineTool(server);

  // Tier 3: Hybrid QA (Fast Scan + Deep Verify)
  registerHybridQATools(server);

  // Tier 2: Native App — System Surfaces
  registerAppPermissionTools(server);
}
