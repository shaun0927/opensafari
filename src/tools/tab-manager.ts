/**
 * TabManager — Singleton registry of TabPool instances, one per booted device.
 *
 * Provides the glue between QA session tools (qa_session_create, etc.) and
 * the existing `TabPool` (src/simulator/tab-pool.ts) infrastructure. Each
 * booted simulator gets its own TabPool that tracks all Safari tabs opened
 * on that device; session IDs returned to clients are stable handles that
 * survive across tool calls.
 *
 * Lifecycle:
 *   1. On first `qa_session_create` for a device, a TabPool is lazily created
 *      bound to that device's boot-time WebKitClient.
 *   2. `openSession()` opens a new Safari tab, wraps it as a `TabClient`, and
 *      registers it with the SessionManager under a fresh session ID.
 *   3. `closeSession()` tears down the tab and removes the session.
 *   4. On device shutdown, `disposeDevice()` closes all tabs for that device.
 */

import { randomUUID } from 'crypto';
import { TabPool } from '../simulator/tab-pool';
import { WebKitClient } from '../webkit/client';
import { getSessionManager, TabSessionInfo } from '../session-manager';

/** Per-device pool registry. Exported for testing. */
const pools: Map<string, TabPool> = new Map();

/**
 * Reset in-memory state. Exported for testing only — callers must also close
 * any tabs that were opened, this does not disconnect underlying clients.
 */
export function resetTabManager(): void {
  pools.clear();
}

/**
 * Get or create the TabPool for a specific device.
 *
 * @param deviceId  Simulator UDID
 * @param client    The boot-time WebKitClient for that device
 */
export function getTabPool(deviceId: string, client: WebKitClient): TabPool {
  let pool = pools.get(deviceId);
  if (!pool) {
    pool = new TabPool(client, deviceId);
    pools.set(deviceId, pool);
  }
  return pool;
}

/**
 * Open a new Safari tab on the specified device and register it as a QA
 * session. Returns the session metadata so callers can later route tool
 * invocations to this tab via its sessionId.
 */
export async function openSession(
  deviceId: string,
  url: string,
  client: WebKitClient,
): Promise<TabSessionInfo> {
  const pool = getTabPool(deviceId, client);
  const tabClient = await pool.openTab(url);
  const targetId = tabClient.getTargetId();

  const info: TabSessionInfo = {
    sessionId: randomUUID(),
    deviceId,
    targetId,
    url,
    client: tabClient,
    createdAt: Date.now(),
  };

  getSessionManager().addTabSession(info);
  return info;
}

/**
 * Close a tab session. The underlying Safari tab is closed via
 * `window.close()` and the dedicated WebKit connection is disconnected.
 * Silently succeeds when the session does not exist.
 */
export async function closeSession(sessionId: string): Promise<boolean> {
  const sm = getSessionManager();
  const info = sm.getTabSession(sessionId);
  if (!info) return false;

  const pool = pools.get(info.deviceId);
  if (pool) {
    try {
      await pool.closeTab(info.targetId);
    } catch (err) {
      console.error(
        `[tab-manager] Failed to close tab ${info.targetId} for session ${sessionId}: ${err}`,
      );
    }
  }

  sm.removeTabSession(sessionId);
  return true;
}

/**
 * Close every tab session associated with a specific device. Called by
 * device_shutdown to prevent leaking tab sessions across reboots.
 */
export async function disposeDevice(deviceId: string): Promise<void> {
  const sm = getSessionManager();
  const sessions = sm.listTabSessions(deviceId);
  for (const s of sessions) {
    await closeSession(s.sessionId);
  }
  const pool = pools.get(deviceId);
  if (pool) {
    try {
      await pool.closeAll();
    } catch {
      /* best effort */
    }
    pools.delete(deviceId);
  }
}

/**
 * List sessions, optionally filtered by device.
 */
export function listSessions(deviceId?: string): TabSessionInfo[] {
  return getSessionManager().listTabSessions(deviceId);
}
