export const ALERT_REASONS = [
  'no_candidate_button',
  'multiple_dialogs_present',
  'ax_scan_timeout',
  'applescript_permission_missing',
  'permission_reset_ambiguous',
  'permission_reset_unknown_service',
  'ok',
] as const;

export type AlertReason = typeof ALERT_REASONS[number];
