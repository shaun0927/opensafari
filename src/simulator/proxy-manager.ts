/**
 * ProxyManager — Per-device WebInspectorProxy registry.
 *
 * The legacy `getSharedProxy()` exposes a single `WebInspectorProxy`
 * singleton that forces every booted simulator to multiplex through one
 * port. This breaks multi-simulator parallel QA in three ways:
 *
 *   1. A single proxy connects to one socket at boot time. When more
 *      simulators are booted after the proxy starts, their sockets are
 *      never queried, so their Safari tabs are invisible.
 *   2. Target selection races across simulators (see #408).
 *   3. Shutting down one simulator cannot cleanly tear down "its" proxy
 *      without affecting the others still attached to the same process.
 *
 * ProxyManager replaces that singleton with a `Map<deviceId, WebInspectorProxy>`.
 * Each device gets its own proxy bound to that simulator's specific
 * `com.apple.webinspectord_sim.socket`, on a unique port derived from the
 * UDID hash (with collision fallback). Lifecycle is per-device:
 *
 *   - `getProxyForDevice(udid)` — lazy create + start a proxy for a
 *     specific simulator; idempotent, reuses the existing instance.
 *   - `stopProxyForDevice(udid)` — stop and delete one device's proxy.
 *     Other devices' proxies are untouched.
 *   - `stopAll()` — teardown all proxies (exposed for tests / shutdown).
 *
 * Phase 2B.1 of #408.
 */

import { WebInspectorProxy } from './proxy';

const PROXY_PORT_BASE_DEFAULT = 9322;
const PROXY_PORT_RANGE_DEFAULT = 100;

interface ManagedProxy {
  proxy: WebInspectorProxy;
  deviceId: string;
  port: number;
}

const managed: Map<string, ManagedProxy> = new Map();
/** Ports reserved (in-use) by this manager across devices. */
const reservedPorts: Set<number> = new Set();

function getPortBase(): number {
  const raw = process.env.OPENSAFARI_PROXY_PORT_BASE;
  if (!raw) return PROXY_PORT_BASE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : PROXY_PORT_BASE_DEFAULT;
}

function getPortRange(): number {
  const raw = process.env.OPENSAFARI_PROXY_PORT_RANGE;
  if (!raw) return PROXY_PORT_RANGE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : PROXY_PORT_RANGE_DEFAULT;
}

/**
 * Deterministic hash → port mapping so a given UDID tends to land on the
 * same port across reboots. Falls back to linear probing when the hashed
 * port is already reserved by another device.
 */
export function allocatePort(deviceId: string): number {
  const base = getPortBase();
  const range = getPortRange();

  // djb2-style hash over the UDID
  let hash = 5381;
  for (let i = 0; i < deviceId.length; i++) {
    hash = ((hash << 5) + hash + deviceId.charCodeAt(i)) | 0;
  }
  const offset = Math.abs(hash) % range;

  // Note: device-list port is one below, so step by 2 to avoid collisions.
  for (let step = 0; step < range; step++) {
    const candidate = base + ((offset + step * 2) % range);
    if (!reservedPorts.has(candidate)) {
      reservedPorts.add(candidate);
      return candidate;
    }
  }

  throw new Error(
    `ProxyManager: no free port in range ${base}-${base + range - 1} ` +
      `(${reservedPorts.size} reserved). Raise OPENSAFARI_PROXY_PORT_RANGE.`,
  );
}

/**
 * Get or create a proxy dedicated to one simulator. The proxy is started
 * bound to that simulator's webinspectord socket (via `targetUdid`), so
 * its /json endpoint only shows Safari targets from that one device.
 */
export async function getProxyForDevice(deviceId: string): Promise<WebInspectorProxy> {
  const existing = managed.get(deviceId);
  if (existing) return existing.proxy;

  const port = allocatePort(deviceId);
  const proxy = new WebInspectorProxy({ port });
  try {
    await proxy.start({ targetUdid: deviceId });
  } catch (err) {
    reservedPorts.delete(port);
    throw err;
  }

  managed.set(deviceId, { proxy, deviceId, port });
  return proxy;
}

/** Return the proxy for a device without starting a new one. */
export function peekProxyForDevice(deviceId: string): WebInspectorProxy | null {
  return managed.get(deviceId)?.proxy ?? null;
}

/** Stop and forget a device's proxy. No-op if none exists. */
export async function stopProxyForDevice(deviceId: string): Promise<void> {
  const entry = managed.get(deviceId);
  if (!entry) return;
  try {
    await entry.proxy.stop();
  } catch (err) {
    console.error(`[proxy-manager] Failed to stop proxy for ${deviceId}: ${err}`);
  }
  reservedPorts.delete(entry.port);
  managed.delete(deviceId);
}

/** Stop every managed proxy. Used on process shutdown / from tests. */
export async function stopAll(): Promise<void> {
  const devices = Array.from(managed.keys());
  for (const id of devices) {
    await stopProxyForDevice(id);
  }
}

/**
 * List current managed proxies. Exported for diagnostics and tests.
 */
export function listManagedProxies(): Array<{ deviceId: string; port: number }> {
  return Array.from(managed.values()).map(({ deviceId, port }) => ({ deviceId, port }));
}

/** Reset state. Test-only — does NOT stop running proxies. */
export function resetProxyManagerState(): void {
  managed.clear();
  reservedPorts.clear();
}
