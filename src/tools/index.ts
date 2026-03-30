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
import { registerQADetectorTools } from './qa-detectors';
import { registerQAAuditTools } from './qa-audit';
import { registerAuthTools } from './auth';
import { registerMockGeolocationTool } from './mock-geolocation';
import { registerNetworkThrottleTool } from './network-throttle';
import { registerErrorLogTool } from './error-log';

export { setWorkflowEngine } from './orchestration-tools';
export { setCrossViewportCapture } from './cross-viewport-compare';
export { setBatchExecutor as setBatchNavigateExecutor } from './batch-navigate';
export { setBatchExecutor as setBatchScreenshotExecutor } from './batch-screenshot';
export { setBatchExecutor as setBatchExecuteExecutor } from './batch-execute';

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

  // Tier 3: Batch Operations
  registerBatchNavigateTool(server);
  registerBatchScreenshotTool(server);
  registerBatchExecuteTool(server);

  // Tier 3: Orchestration (Workflow & Worker lifecycle)
  registerOrchestrationTools(server);

  // Tier 3: Cross-Viewport Comparison
  registerCrossViewportCompareTool(server);

  // Tier 3: QA Detectors
  registerQADetectorTools(server);

  // Tier 3: QA Full Audit (Score + History)
  registerQAAuditTools(server);

  // Tier 3: Auth Persistence
  registerAuthTools(server);

  // Tier 2: Network Throttle
  registerNetworkThrottleTool(server);
}
