/** AX bridge failures that are transient enough to retry or re-capture. */
export const RECOVERABLE_AX_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEVICE_CONTENT_ROOT_EMPTY',
  'AX_TIMEOUT',
  'BRIDGE_EXEC_FAILED',
  'AX_ERROR',
]);

/** AX bridge failures that require caller or environment intervention. */
export const NON_RECOVERABLE_AX_ERROR_CODES: ReadonlySet<string> = new Set([
  'BRIDGE_NOT_FOUND',
  'AX_PERMISSION_DENIED',
]);

export function isRecoverableAxErrorCode(code: string): boolean {
  return RECOVERABLE_AX_ERROR_CODES.has(code);
}
