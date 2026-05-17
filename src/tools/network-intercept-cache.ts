import { NetworkInterceptor } from '../network-interceptor';

const DEFAULT_INTERCEPTOR_SCOPE = '__default__';
const DEFAULT_DEVICE_SCOPE = '__default-device__';

// Keyed by `<sessionId>|<deviceId>` so a single MCP session that targets
// multiple simulators keeps independent interceptor state per device.
// Without the device dimension, toggling network_intercept / network_offline
// on device B mutates the same state used for device A — a cross-device
// state bleed that masks "interception disabled" while leaving stale JS
// hooks active on the sibling device (Codex review on PR #762).
const interceptorsByKey = new Map<string, NetworkInterceptor>();

function makeInterceptorKey(sessionId: string | undefined, deviceId: string | undefined): string {
  const s = sessionId || DEFAULT_INTERCEPTOR_SCOPE;
  const d = deviceId || DEFAULT_DEVICE_SCOPE;
  return `${s}|${d}`;
}

export function getNetworkInterceptorForSession(
  sessionId?: string,
  deviceId?: string,
): NetworkInterceptor {
  const key = makeInterceptorKey(sessionId, deviceId);
  let interceptor = interceptorsByKey.get(key);
  if (!interceptor) {
    interceptor = new NetworkInterceptor();
    interceptorsByKey.set(key, interceptor);
  }
  return interceptor;
}

export function removeNetworkInterceptorForSession(sessionId: string): number {
  if (!sessionId) return 0;

  let removed = 0;
  const prefix = `${sessionId}|`;
  for (const key of Array.from(interceptorsByKey.keys())) {
    if (key === sessionId || key.startsWith(prefix)) {
      interceptorsByKey.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function resetNetworkInterceptorsForTest(): void {
  interceptorsByKey.clear();
}

/** Legacy singleton for callers that are not yet session-aware. */
export const networkInterceptor = getNetworkInterceptorForSession(DEFAULT_INTERCEPTOR_SCOPE);
