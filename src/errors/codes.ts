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
  APP_NOT_INSTALLED = 'APP_NOT_INSTALLED',
  APP_LAUNCH_FAILED = 'APP_LAUNCH_FAILED',
  APP_NOT_RUNNING = 'APP_NOT_RUNNING',
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
  [ErrorCode.APP_NOT_INSTALLED]: { code: ErrorCode.APP_NOT_INSTALLED, recoverable: false, suggestion: 'Install the app on the simulator first (e.g. simctl install)' },
  [ErrorCode.APP_LAUNCH_FAILED]: { code: ErrorCode.APP_LAUNCH_FAILED, recoverable: true, suggestion: 'Verify the bundle ID and that the device is booted' },
  [ErrorCode.APP_NOT_RUNNING]: { code: ErrorCode.APP_NOT_RUNNING, recoverable: true, suggestion: 'Launch the app first using app_launch' },
};
