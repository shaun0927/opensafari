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
  APP_NOT_INSTALLED = 'APP_NOT_INSTALLED',
  APP_LAUNCH_FAILED = 'APP_LAUNCH_FAILED',
  APP_NOT_RUNNING = 'APP_NOT_RUNNING',
  // Keyboard-layout preflight for `app_type_element` / `app_type_text`.
  // Emitted when the simulator's active software keyboard is not a Latin
  // (sw=QWERTY) layout and the tool refuses to type through simhid because
  // the IME would transliterate the requested text (see issue #39).
  KEYBOARD_LAYOUT_NOT_LATIN = 'KEYBOARD_LAYOUT_NOT_LATIN',
  // Emitted when none of the inspected signals (AppleKeyboards preference,
  // TextInput.plist, etc.) exposes a parsable active-keyboard token. The
  // caller cannot decide whether the layout is safe, so the typing path
  // errs on the side of aborting rather than typing through a possibly
  // non-Latin IME.
  KEYBOARD_LAYOUT_DETECTION_FAILED = 'KEYBOARD_LAYOUT_DETECTION_FAILED',

  // ── #797 catalog expansion ────────────────────────────────────────────────
  // Caller-side parameter problems. Emit these instead of ad-hoc
  // {error: 'INVALID_X'} envelopes so the MCP client can branch on a
  // stable taxonomy.
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_REQUIRED_PARAM = 'MISSING_REQUIRED_PARAM',
  INVALID_URL = 'INVALID_URL',

  // Session/device resolution problems. Recoverable — the agent can
  // boot a device or pass an explicit deviceId.
  DEVICE_NOT_BOOTED = 'DEVICE_NOT_BOOTED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  BACKEND_NOT_CONNECTED = 'BACKEND_NOT_CONNECTED',

  // Flutter VM service problems.
  FLUTTER_VM_NOT_CONNECTED = 'FLUTTER_VM_NOT_CONNECTED',
  FLUTTER_EVAL_FAILED = 'FLUTTER_EVAL_FAILED',

  // Gesture/overlay/keyboard helpers.
  OVERLAY_DISMISS_FAILED = 'OVERLAY_DISMISS_FAILED',
  KEYBOARD_DISMISS_FAILED = 'KEYBOARD_DISMISS_FAILED',

  // Alert / permission helpers.
  ALERT_NO_EFFECT = 'ALERT_NO_EFFECT',
  PERMISSION_RESET_DENIED = 'PERMISSION_RESET_DENIED',

  // app_pop_until — fallback ladder outcomes (#801).
  POP_UNTIL_EXHAUSTED = 'POP_UNTIL_EXHAUSTED',
  POP_UNTIL_NO_FALLBACK_AVAILABLE = 'POP_UNTIL_NO_FALLBACK_AVAILABLE',
  MISSING_POSTCONDITION = 'MISSING_POSTCONDITION',
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
  [ErrorCode.APP_NOT_INSTALLED]: { code: ErrorCode.APP_NOT_INSTALLED, recoverable: false, suggestion: 'Install the app on the simulator first (e.g. simctl install)' },
  [ErrorCode.APP_LAUNCH_FAILED]: { code: ErrorCode.APP_LAUNCH_FAILED, recoverable: true, suggestion: 'Verify the bundle ID and that the device is booted' },
  [ErrorCode.APP_NOT_RUNNING]: { code: ErrorCode.APP_NOT_RUNNING, recoverable: true, suggestion: 'Launch the app first using app_launch' },
  [ErrorCode.KEYBOARD_LAYOUT_NOT_LATIN]: {
    code: ErrorCode.KEYBOARD_LAYOUT_NOT_LATIN,
    recoverable: true,
    suggestion:
      'Set the simulator keyboard to English (US) (Settings → General → Keyboard → Keyboards), or retry with backend: "ax-value" for Unicode-safe typing.',
  },
  [ErrorCode.KEYBOARD_LAYOUT_DETECTION_FAILED]: {
    code: ErrorCode.KEYBOARD_LAYOUT_DETECTION_FAILED,
    recoverable: true,
    suggestion:
      'Run scripts/dev/probe-keyboard-layout.ts against the booted UDID to capture the raw preference signals, then file a report so the detector can be widened.',
  },

  // ── #797 catalog expansion ────────────────────────────────────────────────
  [ErrorCode.INVALID_INPUT]: {
    code: ErrorCode.INVALID_INPUT,
    recoverable: true,
    suggestion: 'Check the parameter shape, enum, or range against the tool input schema and retry.',
  },
  [ErrorCode.MISSING_REQUIRED_PARAM]: {
    code: ErrorCode.MISSING_REQUIRED_PARAM,
    recoverable: true,
    suggestion: 'Supply the parameter listed in the message and retry.',
  },
  [ErrorCode.INVALID_URL]: {
    code: ErrorCode.INVALID_URL,
    recoverable: true,
    suggestion: 'URLs must include a scheme (e.g. https:// or myapp://).',
  },
  [ErrorCode.DEVICE_NOT_BOOTED]: {
    code: ErrorCode.DEVICE_NOT_BOOTED,
    recoverable: true,
    suggestion: 'Boot a simulator (device_boot) or pass deviceId explicitly.',
  },
  [ErrorCode.SESSION_NOT_FOUND]: {
    code: ErrorCode.SESSION_NOT_FOUND,
    recoverable: true,
    suggestion: 'Re-open the MCP session or pass an explicit deviceId.',
  },
  [ErrorCode.BACKEND_NOT_CONNECTED]: {
    code: ErrorCode.BACKEND_NOT_CONNECTED,
    recoverable: true,
    suggestion: 'Connect the required backend (e.g. safari navigate, flutter_connect) before retrying.',
  },
  [ErrorCode.FLUTTER_VM_NOT_CONNECTED]: {
    code: ErrorCode.FLUTTER_VM_NOT_CONNECTED,
    recoverable: true,
    suggestion: 'Call flutter_connect first. Release builds without VM service should use the native fallback path.',
  },
  [ErrorCode.FLUTTER_EVAL_FAILED]: {
    code: ErrorCode.FLUTTER_EVAL_FAILED,
    recoverable: true,
    suggestion: 'VM Service evaluate threw. Inspect the message; check that the requested isolate is paused or selected.',
  },
  [ErrorCode.OVERLAY_DISMISS_FAILED]: {
    code: ErrorCode.OVERLAY_DISMISS_FAILED,
    recoverable: true,
    suggestion: 'Try a different mode (drawer / bottom_sheet / dialog), or supply waitForGone to verify the postcondition explicitly.',
  },
  [ErrorCode.KEYBOARD_DISMISS_FAILED]: {
    code: ErrorCode.KEYBOARD_DISMISS_FAILED,
    recoverable: true,
    suggestion: 'Send Escape, tap outside the input, or call app_dismiss_keyboard with force=true.',
  },
  [ErrorCode.ALERT_NO_EFFECT]: {
    code: ErrorCode.ALERT_NO_EFFECT,
    recoverable: true,
    suggestion: 'The targeted alert/permission sheet was not dismissed. Re-query the AX tree to confirm an alert is visible.',
  },
  [ErrorCode.PERMISSION_RESET_DENIED]: {
    code: ErrorCode.PERMISSION_RESET_DENIED,
    recoverable: false,
    suggestion: 'Grant Full Disk Access to the host process (System Settings → Privacy & Security → Full Disk Access) so simctl privacy can manage TCC.',
  },
  [ErrorCode.POP_UNTIL_EXHAUSTED]: {
    code: ErrorCode.POP_UNTIL_EXHAUSTED,
    recoverable: true,
    suggestion: 'All fallback strategies were attempted without satisfying the postcondition. Inspect attempts[] and consider a longer timeout or a more specific postcondition.',
  },
  [ErrorCode.POP_UNTIL_NO_FALLBACK_AVAILABLE]: {
    code: ErrorCode.POP_UNTIL_NO_FALLBACK_AVAILABLE,
    recoverable: false,
    suggestion: 'No native fallback could be selected (no AX bridge, no input backend, or screen geometry unavailable). Connect Flutter VM service or boot a different simulator.',
  },
  [ErrorCode.MISSING_POSTCONDITION]: {
    code: ErrorCode.MISSING_POSTCONDITION,
    recoverable: true,
    suggestion: 'In native (non-VM) contexts, app_pop_until requires a postcondition (route or AX query) so success can be verified.',
  },
};
