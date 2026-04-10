/**
 * Shared helper to resolve the correct BrowserBackend for a tool call.
 *
 * Priority order:
 *   1. If `params.sessionId` is present, return the TabClient registered
 *      under that session id. Unknown session ids return null so the caller
 *      can surface a structured error.
 *   2. Otherwise fall back to the device-level client selected by
 *      `getWebKitClient(params.deviceId)`.
 *
 * This lets tools accept an optional `sessionId` to target a specific
 * Safari tab created via `qa_session_create`, while preserving the legacy
 * "whichever tab the boot-time client is pinned to" behavior.
 */

import { BrowserBackend } from '../types/browser-backend';
import { getWebKitClient } from '../mcp-server';
import { getSessionManager } from '../session-manager';

export interface ResolveResult {
  client: BrowserBackend | null;
  /** 'session' when a sessionId was matched, 'device' otherwise. */
  source: 'session' | 'device' | 'none';
  /** The sessionId the caller passed, if any. */
  sessionId?: string;
  /** Device ID the resolved client is associated with. */
  deviceId?: string;
}

/**
 * Resolve a BrowserBackend from a tool's params.
 */
export function resolveClient(params: Record<string, unknown>): ResolveResult {
  const sessionId = typeof params.sessionId === 'string' && params.sessionId.length > 0
    ? (params.sessionId as string)
    : undefined;

  if (sessionId) {
    const info = getSessionManager().getTabSession(sessionId);
    if (info) {
      return { client: info.client, source: 'session', sessionId, deviceId: info.deviceId };
    }
    return { client: null, source: 'none', sessionId };
  }

  const deviceId = typeof params.deviceId === 'string' ? (params.deviceId as string) : undefined;
  const client = getWebKitClient(deviceId);
  return {
    client: client ?? null,
    source: client ? 'device' : 'none',
    deviceId: deviceId ?? getSessionManager().getSoleDeviceId() ?? undefined,
  };
}

/**
 * Canonical "session not found" error body returned when `sessionId` was
 * provided but the tab has been destroyed or never existed.
 */
export function sessionNotFoundError(sessionId: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'SESSION_NOT_FOUND',
        message: `No QA session with id "${sessionId}". It may have been destroyed or never created. Call qa_session_list to see active sessions.`,
        sessionId,
      }),
    }],
    isError: true,
  };
}

/**
 * Canonical "no client" error body returned when neither a sessionId match
 * nor a device-level client is available.
 */
export function noClientError(): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'NO_WEBKIT_CLIENT',
        message: 'Safari not connected. Call device_boot or qa_session_create first.',
      }),
    }],
    isError: true,
  };
}
