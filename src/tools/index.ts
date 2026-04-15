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
import {
  registerQaSessionCreateTool,
  registerQaSessionDestroyTool,
  registerQaSessionListTool,
} from './qa-session';
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
import { registerAppSwitchAppTool } from './app-switch-app';
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
import { registerAppTreeTool } from './app-tree';
import { registerAppQueryTool } from './app-query';
import { registerAppInspectTool } from './app-inspect';
import { registerAppLaunchTool } from './app-launch';
import { registerAppTerminateTool } from './app-terminate';
import { registerAppListAppsTool } from './app-list-apps';
import { registerAppOpenUrlTool } from './app-open-url';
import { registerAppTapTool } from './app-tap';
import { registerAppDoubleTapTool } from './app-double-tap';
import { registerAppTypeTextTool } from './app-type';
import { registerAppSwipeNativeTool } from './app-swipe';
import { registerAppKeyInputTool } from './app-key-input';
import { registerAppScreenshotNativeTool } from './app-screenshot-native';
import { registerAppLogsTool } from './app-logs';
import { registerAppCrashReportsTool } from './app-crash-reports';
import { registerAppRecordVideoTool } from './app-record-video';
import { registerAppPermissionsTool } from './app-permissions';
import { registerAppDeeplinkTool } from './app-deeplink';
import { registerAppPushNotificationTool } from './app-push-notification';
import { registerAppHandleAlertTool } from './app-handle-alert';
import { registerAppActivateTool } from './app-activate';
import { registerAppListRunningTool } from './app-list-running';
import { registerAppResetTool } from './app-reset';
import { registerAppAlertHandleTool } from './app-alert-handle';
import { registerAppPushTool } from './app-push';
import { registerAppScrollNativeTool } from './app-scroll-native';
import { registerAppDismissKeyboardTool } from './app-dismiss-keyboard';
import { registerAppAssertTool } from './app-assert';
import { registerAppWebviewConnectTool } from './app-webview-connect';
import { registerSetActiveContextTool } from './set-active-context';
import { registerAppPermissionTools } from './app-permission';
import { registerQaFlutterTouchTargetsTool } from './qa-flutter-touch-targets';
import { registerQaFlutterSemanticsTool } from './qa-flutter-semantics';
import { registerQaFlutterDarkModeTool } from './qa-flutter-dark-mode';
import { registerQaFlutterOrientationTool } from './qa-flutter-orientation';
import { registerQaFlutterKeyboardOverlapTool } from './qa-flutter-keyboard-overlap';
import { registerQaFlutterFullAuditTool } from './qa-flutter-full-audit';
import { registerFlutterConnectTool } from './flutter-connect';
import { registerFlutterWidgetTreeTool } from './flutter-widget-tree';
import { registerFlutterHotReloadTool } from './flutter-hot-reload';
import { registerFlutterLogsTool } from './flutter-logs';
import { registerFlutterNetworkTool } from './flutter-network';
import { registerFlutterBuildModeTool } from './flutter-build-mode';
import { registerFlutterDebugPaintTool } from './flutter-debug-paint';
import {
  registerFlutterListServiceExtensionsTool,
  registerFlutterCallServiceExtensionTool,
} from './flutter-service-extensions';
import { registerFlutterEvaluateTool } from './flutter-evaluate';
import {
  registerFlutterRootWidgetTool,
  registerFlutterInspectSelectionTool,
} from './flutter-inspector';
import { registerFlutterWidgetAtPointTool } from './flutter-widget-at-point';
import {
  registerFlutterCpuProfileTool,
  registerFlutterTimelineCaptureTool,
} from './flutter-cpu-profile';
import { registerFlutterTrackRebuildsTool } from './flutter-track-rebuilds';
import {
  registerFlutterAllocationProfileTool,
  registerFlutterHeapSnapshotTool,
} from './flutter-memory-profile';
import {
  registerFlutterSetBreakpointTool,
  registerFlutterRemoveBreakpointTool,
  registerFlutterResumeTool,
  registerFlutterGetStackTool,
  registerFlutterWaitForPauseTool,
} from './flutter-breakpoints';
import { registerAppTapElementTool } from './app-tap-element';
import { registerAppTypeElementTool } from './app-type-element';
import { registerAppWaitForNativeTool } from './app-wait-for';
import { registerAppAssertElementTool } from './app-assert-element';
import { registerDiagnoseTool } from './diagnose';

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

  // Multi-tab QA sessions (Phase 2A of #408)
  registerQaSessionCreateTool(server);
  registerQaSessionDestroyTool(server);
  registerQaSessionListTool(server);

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

  // Tier 2: Native App — System Surfaces
  registerAppSwitchAppTool(server);
  registerAppAlertHandleTool(server);

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

  // Tier 2: Native App — System Surfaces
  registerAppOpenUrlTool(server);
  registerAppPushTool(server);

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

  // Tier 2: Native App Inspection
  registerAppTreeTool(server);
  registerAppQueryTool(server);
  registerAppInspectTool(server);

  // Tier 2: App Lifecycle
  registerAppLaunchTool(server);
  registerAppTerminateTool(server);
  registerAppListAppsTool(server);
  // Tier 2: Native App Interactions
  registerAppTapTool(server);
  registerAppDoubleTapTool(server);
  registerAppTypeTextTool(server);
  registerAppSwipeNativeTool(server);
  registerAppKeyInputTool(server);
  // Tier 2: Native App Observability
  registerAppScreenshotNativeTool(server);
  registerAppLogsTool(server);
  registerAppCrashReportsTool(server);
  registerAppRecordVideoTool(server);
  // Tier 2: App Lifecycle
  // Tier 2: Native App System Surfaces
  registerAppPermissionsTool(server);
  registerAppDeeplinkTool(server);
  registerAppPushNotificationTool(server);
  registerAppHandleAlertTool(server);
  registerAppActivateTool(server);
  registerAppListRunningTool(server);
  registerAppResetTool(server);
  // Tier 2: Native App Interactions
  registerAppScrollNativeTool(server);
  // Tier 2: Native App Interaction
  registerAppDismissKeyboardTool(server);
  // Tier 2: Native Assertions (CI-friendly)
  registerAppAssertTool(server);
  // Tier 2: Hybrid context switching
  registerAppWebviewConnectTool(server);
  registerSetActiveContextTool(server);
  // Tier 2: Native App — System Surfaces
  registerAppPermissionTools(server);

  // Tier 2: Flutter QA Detectors
  registerQaFlutterTouchTargetsTool(server);
  registerQaFlutterSemanticsTool(server);
  registerQaFlutterDarkModeTool(server);
  registerQaFlutterOrientationTool(server);
  registerQaFlutterKeyboardOverlapTool(server);

  // Tier 3: Flutter QA Audit (Orchestrator)
  registerQaFlutterFullAuditTool(server);

  // Tier 2: Flutter VM Service (debug/profile builds only)
  registerFlutterConnectTool(server);
  registerFlutterWidgetTreeTool(server);
  registerFlutterHotReloadTool(server);
  registerFlutterLogsTool(server);

  // Tier 2: Flutter Network Monitoring
  registerFlutterNetworkTool(server);

  // Tier 2: Flutter Build Mode Detector (issue #442)
  registerFlutterBuildModeTool(server);

  // Tier 2: Flutter Debug Paint Overlays (issue #437)
  registerFlutterDebugPaintTool(server);
  // Tier 2: Flutter Service Extensions (issue #441)
  registerFlutterListServiceExtensionsTool(server);
  registerFlutterCallServiceExtensionTool(server);
  // Tier 2: Flutter Expression Evaluation (issue #434)
  registerFlutterEvaluateTool(server);
  // Tier 2: Flutter Inspector (issue #436)
  registerFlutterRootWidgetTool(server);
  registerFlutterInspectSelectionTool(server);
  registerFlutterWidgetAtPointTool(server);
  // Tier 2: Flutter Performance Profiling (issue #439)
  registerFlutterCpuProfileTool(server);
  registerFlutterTimelineCaptureTool(server);
  // Tier 2: Flutter Rebuild Tracking (issue #438)
  registerFlutterTrackRebuildsTool(server);
  // Tier 2: Flutter Memory Profiling (issue #440)
  registerFlutterAllocationProfileTool(server);
  registerFlutterHeapSnapshotTool(server);
  // Tier 2: Flutter Breakpoint / Step Debugging (issue #435)
  registerFlutterSetBreakpointTool(server);
  registerFlutterRemoveBreakpointTool(server);
  registerFlutterResumeTool(server);
  registerFlutterGetStackTool(server);
  registerFlutterWaitForPauseTool(server);

  // Tier 2: Native App — Semantic Interaction (Flutter-compatible)
  registerAppTapElementTool(server);
  registerAppTypeElementTool(server);
  // Tier 2: Native App — Semantic Wait & Assert (Flutter-compatible)
  registerAppWaitForNativeTool(server);
  registerAppAssertElementTool(server);

  // Tier 1: Diagnostics
  registerDiagnoseTool(server);
}
