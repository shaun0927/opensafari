/**
 * Tool Tier Configuration — Progressive Disclosure
 * Tier 1: Always visible, Tier 2: On-demand, Tier 3: Auth & orchestration
 */

export const TOOL_TIERS: Record<string, number> = {
  // Tier 1: Core (always visible)
  navigate: 1,
  screenshot: 1,
  javascript: 1,
  read_page: 1,
  click: 1,
  type: 1,
  scroll: 1,
  query_dom: 1,
  cookies: 1,
  device_boot: 1,
  device_shutdown: 1,

  // Tier 2: Advanced (on-demand)
  inspect: 2,
  wait_for: 2,
  long_press: 2,
  swipe: 2,
  press: 2,
  dismiss_keyboard: 2,
  select_option: 2,
  device_list: 2,
  device_rotate: 2,
  appearance_toggle: 2,
  mock_geolocation: 2,
  network_throttle: 2,
  error_log: 2,
  console_log: 2,
  network_log: 2,
  network_har: 2,
  mock_permission: 2,
  network_intercept: 2,
  network_offline: 2,
  app_tree: 2,
  app_query: 2,
  app_inspect: 2,
  app_launch: 2,
  app_terminate: 2,
  app_list_apps: 2,
  app_open_url: 2,

  // Tier 2: Native App Interactions
  app_tap: 2,
  app_double_tap: 2,
  app_type_text: 2,
  app_swipe_native: 2,
  app_key_input: 2,

  // Tier 2: Native App Observability
  app_screenshot_native: 2,
  app_logs: 2,
  app_crash_reports: 2,
  app_record_video: 2,
  app_permissions: 2,
  app_deeplink: 2,
  app_push_notification: 2,
  app_handle_alert: 2,
  app_activate: 2,
  app_list_running: 2,
  app_switch_app: 2,
  app_reset: 2,
  app_alert_handle: 2,
  app_push: 2,
  app_scroll_native: 2,
  app_dismiss_keyboard: 2,
  app_permission_set: 2,
  app_permission_reset: 2,

  // Tier 3: Auth & orchestration
  auth_save: 3,
  auth_restore: 3,
  auth_list: 3,
  workflow_init: 3,
  workflow_status: 3,
  workflow_collect: 3,
  workflow_collect_partial: 3,
  workflow_cleanup: 3,
  worker_update: 3,
  worker_complete: 3,
  qa_full_audit: 3,
  batch_screenshot: 3,
  batch_navigate: 3,
  batch_execute: 3,
  cross_viewport_compare: 3,
  run_scenario: 3,
  barrier_wait: 3,
  barrier_status: 3,
  barrier_clear: 3,
  assert_all_devices: 3,
  performance_audit: 3,
  compare_devices: 3,
  app_assert: 2,

  // Tier 2: Flutter QA Detectors
  qa_flutter_touch_targets: 2,
  qa_flutter_semantics: 2,
  qa_flutter_dark_mode: 2,
  qa_flutter_orientation: 2,
  qa_flutter_keyboard_overlap: 2,

  // Tier 3: Flutter QA Audit (Orchestrator)
  qa_flutter_full_audit: 3,

  // Tier 2: Flutter VM Service (debug/profile builds only)
  flutter_connect: 2,
  flutter_widget_tree: 2,
  flutter_hot_reload: 2,
  flutter_logs: 2,

  // Tier 2: Flutter Network Monitoring
  flutter_network: 2,

  // Tier 2: Flutter Build Mode Detector (issue #442)
  flutter_build_mode: 2,

  // Tier 2: Flutter Debug Paint Overlays (issue #437)
  flutter_toggle_debug_paint: 2,
  // Tier 2: Flutter Service Extensions (issue #441)
  flutter_list_service_extensions: 2,
  flutter_call_service_extension: 2,
  // Tier 2: Flutter Expression Evaluation (issue #434)
  flutter_evaluate: 2,
  // Tier 2: Flutter Inspector (issue #436)
  flutter_root_widget: 2,
  flutter_inspect_selection: 2,
  flutter_widget_at_point: 2,
  // Tier 2: Flutter Performance Profiling (issue #439)
  flutter_cpu_profile: 2,
  flutter_timeline_capture: 2,
  // Tier 2: Flutter Rebuild Tracking (issue #438)
  flutter_track_rebuilds: 2,
  // Tier 2: Flutter Memory Profiling (issue #440)
  flutter_allocation_profile: 2,
  flutter_heap_snapshot: 2,
  // Tier 2: Flutter Breakpoint / Step Debugging (issue #435)
  flutter_set_breakpoint: 2,
  flutter_remove_breakpoint: 2,
  flutter_resume: 2,
  flutter_get_stack: 2,
  flutter_wait_for_pause: 2,

  // Tier 2: Native App — Semantic Interaction (Flutter-compatible)
  app_tap_element: 2,
  app_type_element: 2,
  // Tier 2: Native App — Semantic Wait & Assert (Flutter-compatible)
  app_wait_for_element: 2,
  app_assert_element: 2,

  // Tier 2: Hybrid context switching
  app_webview_connect: 2,
  set_active_context: 2,

  // Tier 2: QA Detectors
  qa_auto_zoom: 2,
  qa_touch_targets: 2,
  qa_hover_only: 2,
  qa_input_type: 2,
  qa_safe_area: 2,
  qa_keyboard_overlap: 2,
  qa_horizontal_overflow: 2,
  qa_100vh: 2,
  qa_fixed_stacking: 2,
  qa_scroll_lock: 2,
  qa_dark_mode: 2,
  qa_orientation: 2,
  qa_pwa_meta: 2,

  // Tier 2: Hybrid QA
  hybrid_qa_start: 2,
  hybrid_qa_status: 2,
  hybrid_qa_results: 2,

  // Tier 1: Diagnostics
  diagnose: 1,

  // Tier 2: QA sessions
  qa_session_create: 2,
  qa_session_destroy: 2,
  qa_session_list: 2,

  // Tier 2: Native auth & OTP
  auth_save_native: 2,
  auth_restore_native: 2,
  auth_list_native: 2,
  auth_delete_native: 2,
  auth_otp_fetch: 2,

  // Tier 2: Device network conditioning
  device_network_set: 2,
  device_network_get: 2,

  // Tier 2: Native app context & navigation helpers
  app_context: 2,
  app_state_snapshot: 2,
  app_testflight_iap_snapshot: 2,
  mac_app_launch: 2,
  mac_app_tree: 2,
  mac_app_tap_element: 2,
  mac_app_screenshot: 2,
  mac_app_context: 2,
  mac_app_query: 2,
  mac_debug_bundle_collect: 2,
  mac_testflight_snapshot: 2,
  mac_testflight_find_build: 2,
  mac_testflight_install_update_open: 2,
  mac_testflight_qa_run: 2,
  app_list_routes: 2,
  app_notes_paste_and_tap_url: 2,
  app_dismiss_overlay: 2,
  app_biometric: 2,
  app_wait_for: 2,
  app_pop_until: 2,
  app_goto_screen: 2,

  // Tier 2: Flutter route inspection
  flutter_get_route: 2,

  // Tier 2: Diagnostics bundles
  debug_bundle_collect: 2,
};

export function getToolTier(toolName: string): number {
  // Unassigned tools fall back to tier 3 so a missing TOOL_TIERS entry can
  // never silently expand the default tools/list surface. Every registered
  // tool must have an explicit entry (enforced by tool-tier-drift.test.ts).
  return TOOL_TIERS[toolName] ?? 3;
}
