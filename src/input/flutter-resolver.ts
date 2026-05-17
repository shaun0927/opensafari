/**
 * Flutter VM resolver — discovers a connected FlutterVMClient for a device.
 *
 * Extracted from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. Resolution policy is strictly unchanged: returns null for native
 * iOS apps and devices without a Flutter debug/profile build.
 */

import type { FlutterVMClient } from '../flutter';
import { getFlutterVMClient, removeFlutterVMClient } from '../flutter';

// ── Cache entry ──────────────────────────────────────────────────────────────

// Per-device cache of the Flutter VM client connection so subsequent Tier-0
// lookups reuse an already-established WebSocket instead of re-running
// discovery on every call.
//
// Value semantics:
//   - FlutterVMClient: positive hit (Flutter app connected; reuse)
//   - null: negative hit (discovery already failed within NEGATIVE_CACHE_TTL_MS;
//     skip discovery and let the caller fall through to Tier 1-3)
interface FlutterClientCacheEntry {
  client: FlutterVMClient | null;
  expiresAt: number;
}

// Negative cache TTL: after a failed discovery, don't re-probe for this long.
// Native iOS apps, Safari, and any simulator without a Flutter debug build
// would otherwise pay the full discovery cost on every `getInputBackend()`
// call, stalling tools like `app_scroll_native` / `app_tap` well past their
// unit-test timeouts.
const NEGATIVE_CACHE_TTL_MS = 30_000;

// Upper bound on how long the initial VM-discovery probe is allowed to block.
// If discovery has not produced a connected client within this window, treat
// the device as non-Flutter so native-app code paths aren't penalised.
const DISCOVERY_TIMEOUT_MS = 1_500;

// ── Resolver type ─────────────────────────────────────────────────────────────

/**
 * Overridable resolver that returns a connected `FlutterVMClient` for the
 * device, or `null` when no Flutter VM is discoverable (native app, Safari,
 * simulator without Flutter debug build).
 */
export type FlutterVMResolver = (deviceId: string) => Promise<FlutterVMClient | null>;

// ── Default resolver implementation ──────────────────────────────────────────

async function defaultFlutterVMResolver(
  deviceId: string,
  cache: Map<string, FlutterClientCacheEntry>,
): Promise<FlutterVMClient | null> {
  const now = Date.now();
  const cached = cache.get(deviceId);
  if (cached && cached.expiresAt > now) {
    // Fast path: cached positive hit that is still connected.
    if (cached.client && cached.client.isConnected()) {
      return cached.client;
    }
    // Fast path: cached negative hit within TTL.
    if (cached.client === null) {
      return null;
    }
    // Stale positive entry (client disconnected). Fall through to re-probe.
  }

  // Bound the discovery probe so non-Flutter devices don't stall tools
  // that legitimately just want Tier 1-3.
  try {
    const client = getFlutterVMClient(deviceId);
    if (!client.isConnected()) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const explicitUrl = process.env.OPENSAFARI_VM_SERVICE_URL;
      const effectiveTimeout = explicitUrl ? 10_000 : DISCOVERY_TIMEOUT_MS;
      const timeout = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('flutter-vm-discovery-timeout')),
          effectiveTimeout,
        );
      });
      try {
        await Promise.race([client.connect({ deviceId, vmServiceUrl: process.env.OPENSAFARI_VM_SERVICE_URL || undefined }), timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    if (!client.isConnected()) {
      cache.set(deviceId, {
        client: null,
        expiresAt: now + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    // The VM is reachable, but FlutterVMInputBackend can only drive input
    // through `evaluate` — which requires DDS + the frontend compiler
    // (debug/profile builds only). Release builds and apps launched via
    // `xcrun simctl launch` expose the VM Service socket without the
    // compile service, and any `evaluate` call rejects with `code: 113`.
    // Probe once up-front so that case falls through to the next tier
    // instead of surfacing the raw 113 error to the user.
    const probe = await client.probeEvaluateCompile();
    if (!probe.available) {
      // Close the orphaned WebSocket — the client is not reusable on negative
      // probe, so leaving it in the singleton map leaks a file descriptor per
      // discovery cycle on release-mode Flutter apps.
      removeFlutterVMClient(deviceId);
      if (probe.reason === 'compile-error-113') {
        console.error(
          `[input-backend] Flutter VM on ${deviceId} rejects evaluate (code 113). ` +
            'Likely a release build or `simctl launch` without `flutter run` — ' +
            'falling back past Tier 0. Set OPENSAFARI_DISABLE_AX_PRESS=0 to use ' +
            'Tier 1.5 for element-targeted taps.',
        );
      }
      cache.set(deviceId, {
        client: null,
        expiresAt: now + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    cache.set(deviceId, { client, expiresAt: Infinity });
    return client;
  } catch {
    // VM discovery / connect failures are expected for non-Flutter apps.
    // Cache the negative result so the next call doesn't pay the probe cost.
    cache.set(deviceId, {
      client: null,
      expiresAt: now + NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

// ── FlutterVMResolverInstance ─────────────────────────────────────────────────

/**
 * Encapsulates the Flutter VM discovery cache and resolver override, owned per
 * `InputBackendResolver` instance so state is never shared across instances.
 */
export class FlutterVMResolverInstance {
  private cache = new Map<string, FlutterClientCacheEntry>();
  private pendingResolutions = new Map<string, Promise<FlutterVMClient | null>>();
  private resolver: FlutterVMResolver;

  constructor() {
    this.resolver = (deviceId) => defaultFlutterVMResolver(deviceId, this.cache);
  }

  /**
   * Attempt to resolve a FlutterVMClient for this device. Returns null whenever
   * the device is not running a Flutter app in debug/profile mode. Never
   * throws — VM discovery errors collapse to null so the tier fallback keeps
   * working for native iOS apps.
   */
  async resolve(deviceId: string): Promise<FlutterVMClient | null> {
    const pending = this.pendingResolutions.get(deviceId);
    if (pending) return pending;

    const resolution = (async () => {
      try {
        return await this.resolver(deviceId);
      } catch {
        return null;
      }
    })();

    this.pendingResolutions.set(deviceId, resolution);
    try {
      return await resolution;
    } finally {
      this.pendingResolutions.delete(deviceId);
    }
  }

  /**
   * Override the resolver. Pass `null` to restore the default.
   * Intended for unit tests only.
   */
  setResolver(resolver: FlutterVMResolver | null): void {
    if (resolver === null) {
      this.resolver = (deviceId) => defaultFlutterVMResolver(deviceId, this.cache);
    } else {
      this.resolver = resolver;
    }
  }

  /** Current number of entries in the cache (positive + negative). */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Clear all cached entries and reset the resolver to default. */
  reset(): void {
    this.cache.clear();
    this.pendingResolutions.clear();
    this.resolver = (deviceId) => defaultFlutterVMResolver(deviceId, this.cache);
  }
}
