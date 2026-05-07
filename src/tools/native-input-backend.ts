/**
 * NativeInputBackend — compatibility shim.
 *
 * All concrete backends, the resolver, and the error class have been split into
 * focused modules under `src/input/` as part of the #707 (a) refactor.
 * This file re-exports every previously-public symbol so existing callers
 * (`src/tools/native-input-utils.ts`, `src/metrics/cache-budget.ts`, etc.)
 * continue to work without modification.
 *
 * Behavior is unchanged: no fallback semantics were altered; no public tool
 * API was modified.
 *
 * New consumers should import directly from:
 *   - `../input/backend`            — InputBackend interface + InputBackendKind
 *   - `../input/simctl-backend`     — SimctlInputBackend
 *   - `../input/applescript-backend`— AppleScriptInputBackend + key maps
 *   - `../input/webkit-backend`     — WebKitInputBackend + key maps
 *   - `../input/flutter-resolver`   — FlutterVMResolver, FlutterVMResolverInstance
 *   - `../input/backend-resolver`   — InputBackendResolver, HeadlessInputUnavailableError
 */

// ── Re-exports: types & interfaces ───────────────────────────────────────────

export type { InputBackend, InputBackendKind } from '../input/backend';

// ── Re-exports: concrete backends ────────────────────────────────────────────

export { SimctlInputBackend } from '../input/simctl-backend';
export { AppleScriptInputBackend } from '../input/applescript-backend';
export { WebKitInputBackend } from '../input/webkit-backend';

// ── Re-exports: key maps ─────────────────────────────────────────────────────

export {
  HID_TO_APPLESCRIPT,
  SENDKEY_TO_APPLESCRIPT,
} from '../input/applescript-backend';

export {
  HID_TO_WEBKIT_KEY,
  SENDKEY_TO_WEBKIT_KEY,
} from '../input/webkit-backend';

// ── Re-exports: error class + env var constants ───────────────────────────────

export {
  HeadlessInputUnavailableError,
  OPENSAFARI_ALLOW_FOCUS_INPUT_ENV,
  OPENSAFARI_HEADLESS_ONLY_ENV,
} from '../input/backend-resolver';

// ── Compatibility shim: module-level functions ────────────────────────────────
//
// These delegate to the default singleton InputBackendResolver so all existing
// callers see the same cached state as before.

import { defaultResolver } from '../input/backend-resolver';
import type { FlutterVMResolver } from '../input/flutter-resolver';
import type { BrowserBackend } from '../types/browser-backend';
import type { InputBackend } from '../input/backend';

/**
 * Get the input backend using the 4-tier fallback strategy.
 * Delegates to the default InputBackendResolver singleton.
 *
 * @param deviceId      Simulator UDID
 * @param webkitClient  Optional WebKit/Safari connection for Tier 2
 * @throws {HeadlessInputUnavailableError} When no headless method is available
 */
export async function getInputBackend(
  deviceId: string,
  webkitClient?: BrowserBackend | null,
): Promise<InputBackend> {
  return defaultResolver.getInputBackend(deviceId, webkitClient);
}

/**
 * Attempt to resolve a FlutterVMClient for this device. Returns null whenever
 * the device is not running a Flutter app in debug/profile mode. Never throws.
 *
 * Exposed so callers (e.g. routing diagnostics) can probe availability
 * without spinning up the backend; the public routing in `getInputBackend()`
 * is the normal entry point.
 */
export async function tryGetFlutterVMClient(
  deviceId: string,
): Promise<import('../flutter').FlutterVMClient | null> {
  return defaultResolver.tryGetFlutterVMClient(deviceId);
}

/** Reset the cached backend state. Exported for testing only. */
export function resetInputBackend(): void {
  defaultResolver.reset();
}

/**
 * Current number of entries in the Flutter VM discovery cache.
 * Exposed for the cache-budget survey (#554).
 */
export function getFlutterClientCacheSize(): number {
  return defaultResolver.getFlutterClientCacheSize();
}

/**
 * Test seam: override the Flutter VM resolver on the default singleton.
 * Pass `null` to restore the default.
 * Only used by unit tests.
 */
export function __setFlutterVMResolverForTest(
  resolver: FlutterVMResolver | null,
): void {
  defaultResolver.setFlutterVMResolver(resolver);
}
