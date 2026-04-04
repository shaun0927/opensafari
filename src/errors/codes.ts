export enum ErrorCode {
  SIM_BOOT_FAILED = 'SIM_BOOT_FAILED',
  SIM_CRASH = 'SIM_CRASH',
  SIM_SHUTDOWN_FAILED = 'SIM_SHUTDOWN_FAILED',
  SAFARI_TIMEOUT = 'SAFARI_TIMEOUT',
  SAFARI_CRASH = 'SAFARI_CRASH',
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',
  XCODE_NOT_FOUND = 'XCODE_NOT_FOUND',
  WEBKIT_CONNECT_FAILED = 'WEBKIT_CONNECT_FAILED',
  WEBKIT_PROTOCOL_ERROR = 'WEBKIT_PROTOCOL_ERROR',
  ACCESSIBILITY_UNAVAILABLE = 'ACCESSIBILITY_UNAVAILABLE',
  NATIVE_GESTURE_FAILED = 'NATIVE_GESTURE_FAILED',
  APP_STATE_UNKNOWN = 'APP_STATE_UNKNOWN',
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestion: string;
}

export const ERROR_CATALOG: Record<ErrorCode, Omit<StructuredError, 'message'>> = {
  [ErrorCode.SIM_BOOT_FAILED]: { code: ErrorCode.SIM_BOOT_FAILED, recoverable: true, suggestion: 'Check Xcode installation and available disk space' },
  [ErrorCode.SIM_CRASH]: { code: ErrorCode.SIM_CRASH, recoverable: true, suggestion: 'Simulator will auto-recover. Check system memory' },
  [ErrorCode.SIM_SHUTDOWN_FAILED]: { code: ErrorCode.SIM_SHUTDOWN_FAILED, recoverable: true, suggestion: 'Try force shutdown via simctl erase' },
  [ErrorCode.SAFARI_TIMEOUT]: { code: ErrorCode.SAFARI_TIMEOUT, recoverable: true, suggestion: 'Increase timeout or check page load speed' },
  [ErrorCode.SAFARI_CRASH]: { code: ErrorCode.SAFARI_CRASH, recoverable: true, suggestion: 'Safari will auto-restart. Reduce page complexity' },
  [ErrorCode.AUTH_EXPIRED]: { code: ErrorCode.AUTH_EXPIRED, recoverable: true, suggestion: 'Re-run opensafari auth save to refresh credentials' },
  [ErrorCode.RESOURCE_EXHAUSTED]: { code: ErrorCode.RESOURCE_EXHAUSTED, recoverable: false, suggestion: 'Close other apps or reduce simulator count' },
  [ErrorCode.XCODE_NOT_FOUND]: { code: ErrorCode.XCODE_NOT_FOUND, recoverable: false, suggestion: 'Install Xcode from the App Store' },
  [ErrorCode.WEBKIT_CONNECT_FAILED]: { code: ErrorCode.WEBKIT_CONNECT_FAILED, recoverable: true, suggestion: 'Ensure ios-webkit-debug-proxy is running' },
  [ErrorCode.WEBKIT_PROTOCOL_ERROR]: { code: ErrorCode.WEBKIT_PROTOCOL_ERROR, recoverable: true, suggestion: 'Check WebKit Inspector Protocol compatibility' },
  [ErrorCode.ACCESSIBILITY_UNAVAILABLE]: { code: ErrorCode.ACCESSIBILITY_UNAVAILABLE, recoverable: false, suggestion: 'Enable accessibility on the simulator or check app supports accessibility' },
  [ErrorCode.NATIVE_GESTURE_FAILED]: { code: ErrorCode.NATIVE_GESTURE_FAILED, recoverable: true, suggestion: 'Verify target coordinates are within screen bounds and app is in foreground' },
  [ErrorCode.APP_STATE_UNKNOWN]: { code: ErrorCode.APP_STATE_UNKNOWN, recoverable: true, suggestion: 'Check if the app bundle ID is correct and the simulator is running' },
};
