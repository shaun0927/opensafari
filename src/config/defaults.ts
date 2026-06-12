/**
 * OpenSafari Default Constants
 * Timeouts, thresholds, and limits
 */

// Simulator
export const DEFAULT_SIMULATOR_BOOT_TIMEOUT_MS = 15000;
export const DEFAULT_SIMULATOR_SHUTDOWN_TIMEOUT_MS = 10000;
export const DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS = 300000;
export const DEFAULT_MAX_SIMULATORS = 3;

// WebKit Protocol
export const DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS = 10000;
export const DEFAULT_WEBKIT_SEND_TIMEOUT_MS = 15000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
/**
 * Consecutive heartbeat failures tolerated before tearing down the connection.
 * A single failed probe is routinely benign (page JS busy past the send
 * timeout, active target briefly absent during navigation), so reconnecting
 * on the first failure amplifies transient slowness into a full teardown.
 */
export const DEFAULT_HEARTBEAT_FAILURE_THRESHOLD = 3;
export const DEFAULT_RECONNECT_MAX_ATTEMPTS = 10;
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

// Navigation
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
export const DEFAULT_NETWORKIDLE_WAIT_MS = 500;

// Screenshot
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 10000;

// Evaluate
export const DEFAULT_EVALUATE_TIMEOUT_MS = 15000;

// Flutter VM Service (Dart VM Service WebSocket)
export const DEFAULT_FLUTTER_VM_REQUEST_TIMEOUT_MS = 10000;
/** Long-running ext.flutter / inspector calls — widget tree, reload, evaluate. */
export const DEFAULT_FLUTTER_VM_HEAVY_TIMEOUT_MS = 60000;
export const DEFAULT_FLUTTER_VM_CONNECT_TIMEOUT_MS = 5000;
export const DEFAULT_FLUTTER_VM_HEARTBEAT_INTERVAL_MS = 30000;
export const DEFAULT_FLUTTER_VM_RECONNECT_MAX_ATTEMPTS = 5;
export const DEFAULT_FLUTTER_VM_RECONNECT_BASE_DELAY_MS = 1000;
export const DEFAULT_FLUTTER_VM_RECONNECT_MAX_DELAY_MS = 16000;

// QA Detectors
export const DEFAULT_DETECTOR_TIMEOUT_MS = 5000;
export const DEFAULT_TOUCH_TARGET_MIN_SIZE = 44;
export const DEFAULT_INPUT_MIN_FONT_SIZE = 16;

// Resource Monitoring
export const DEFAULT_MEMORY_WARN_MB = 400;
export const DEFAULT_MEMORY_KILL_MB = 600;
export const DEFAULT_RESOURCE_CHECK_INTERVAL_MS = 30000;
export const DEFAULT_IDLE_CHECK_INTERVAL_MS = 60000;

// Health
export const DEFAULT_HEALTH_PORT = 9090;

// Disk
export const DEFAULT_DISK_CHECK_INTERVAL_MS = 300000;
export const DEFAULT_DISK_WARN_MB = 500;
export const DEFAULT_REPORT_MAX_AGE_DAYS = 30;
export const DEFAULT_SCREENSHOT_MAX_AGE_DAYS = 7;

// Rate Limiting
export const DEFAULT_RATE_LIMIT_REQUESTS = 100;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;

// Proxy readiness
/** How long to wait for the ios_webkit_debug_proxy process HTTP endpoint to respond. */
export const DEFAULT_PROXY_PROCESS_READY_TIMEOUT_MS = 5000;
/** How long to wait for a Safari/WebView page target to appear when explicitly requested. */
export const DEFAULT_PROXY_TARGET_WAIT_TIMEOUT_MS = 15000;
/** Initial poll interval when waiting for a target; doubles each iteration up to the cap. */
export const DEFAULT_PROXY_POLL_INITIAL_MS = 200;
/** Maximum poll interval cap for adaptive target polling. */
export const DEFAULT_PROXY_POLL_MAX_MS = 2000;
