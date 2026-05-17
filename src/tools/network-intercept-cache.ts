import { NetworkInterceptor } from '../network-interceptor';

const DEFAULT_INTERCEPTOR_SCOPE = '__default__';
const interceptorsBySession = new Map<string, NetworkInterceptor>();

function resolveInterceptorScope(sessionId?: string): string {
  return sessionId || DEFAULT_INTERCEPTOR_SCOPE;
}

export function getNetworkInterceptorForSession(sessionId?: string): NetworkInterceptor {
  const key = resolveInterceptorScope(sessionId);
  let interceptor = interceptorsBySession.get(key);
  if (!interceptor) {
    interceptor = new NetworkInterceptor();
    interceptorsBySession.set(key, interceptor);
  }
  return interceptor;
}

export function removeNetworkInterceptorForSession(sessionId: string): number {
  if (!sessionId) return 0;

  let removed = 0;
  for (const key of Array.from(interceptorsBySession.keys())) {
    if (key === sessionId || key.startsWith(`${sessionId}|`)) {
      interceptorsBySession.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function resetNetworkInterceptorsForTest(): void {
  interceptorsBySession.clear();
}

/** Legacy singleton for callers that are not yet session-aware. */
export const networkInterceptor = getNetworkInterceptorForSession(DEFAULT_INTERCEPTOR_SCOPE);
