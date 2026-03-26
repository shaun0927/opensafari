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
  device_snapshot: 2,

  // Tier 3: Auth & orchestration
  auth_save: 3,
  auth_restore: 3,
  auth_list: 3,
  workflow_init: 3,
  workflow_status: 3,
  workflow_collect: 3,
  worker_update: 3,
  worker_complete: 3,
  qa_full_audit: 3,
  batch_screenshot: 3,
  batch_navigate: 3,
  batch_execute: 3,
  cross_viewport_compare: 3,
};

export function getToolTier(toolName: string): number {
  return TOOL_TIERS[toolName] ?? 2;
}
