/**
 * InputBackendResolver — encapsulates backend detection, caching, and the
 * 4-tier fallback strategy with default-deny hardening for the focus-stealing
 * path.
 *
 * Extracted from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. Resolution policy and fallback order are strictly unchanged.
 *
 * Tier order (highest priority first):
 *   0. FlutterVMInputBackend  — Flutter VM Service (debug/profile builds only)
 *   1. PointerService         — opt-in experimental (#590 Phase 1)
 *   1. SimulatorKitHID        — headless, any app, all Xcode versions
 *   2. SimctlInputBackend     — `simctl io input` (Xcode ≤ 16)
 *   2. WebKitInputBackend     — JS touch events via WebKit (Safari only)
 *   3. AppleScriptInputBackend — CGEvent / focus-stealing, DEFAULT-DENY
 */

import { SimctlExecutor } from '../simulator/simctl';
import type { BrowserBackend } from '../types/browser-backend';
import { FlutterVMInputBackend } from './flutter-vm-backend';
import { tryCreateSimulatorKitHIDBackend } from './sim-hid-backend';
import {
  isPointerServiceEnabled,
  tryCreatePointerServiceBackend,
} from './pointer-service-backend';
import type { InputBackend } from './backend';
import { SimctlInputBackend } from './simctl-backend';
import { AppleScriptInputBackend } from './applescript-backend';
import { WebKitInputBackend } from './webkit-backend';
import { FlutterVMResolverInstance } from './flutter-resolver';
import type { FlutterVMResolver } from './flutter-resolver';

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Environment variable that opts in to the focus-stealing AppleScript / CGEvent
 * input backend. When unset (the default), `getInputBackend()` refuses to
 * instantiate `AppleScriptInputBackend` and throws `HeadlessInputUnavailableError`
 * instead, preventing silent focus theft.
 */
export const OPENSAFARI_ALLOW_FOCUS_INPUT_ENV = 'OPENSAFARI_ALLOW_FOCUS_INPUT';
export const OPENSAFARI_HEADLESS_ONLY_ENV = 'OPENSAFARI_HEADLESS_ONLY';

function isFocusInputAllowed(): boolean {
  const value = process.env[OPENSAFARI_ALLOW_FOCUS_INPUT_ENV];
  return value === '1' || value === 'true';
}

function isHeadlessOnly(): boolean {
  const value = process.env[OPENSAFARI_HEADLESS_ONLY_ENV];
  return value === '1' || value === 'true';
}

/**
 * Thrown by `getInputBackend()` when no headless input method is available and
 * the caller has not opted in to the focus-stealing fallback.
 */
export class HeadlessInputUnavailableError extends Error {
  readonly name = 'HeadlessInputUnavailableError' as const;
  readonly deviceId: string;
  readonly reason:
    | 'no-simctl'
    | 'no-webkit'
    | 'webkit-disconnected'
    | 'headless-only';
  readonly remediation: readonly string[];

  constructor(
    deviceId: string,
    reason: HeadlessInputUnavailableError['reason'],
  ) {
    const remediation =
      reason === 'headless-only'
        ? ([
            `${OPENSAFARI_HEADLESS_ONLY_ENV}=1 is set — AppleScript/CGEvent fallback is blocked.`,
            'Ensure a headless backend (simctl, webkit, flutter-vm, simhid) is available.',
            `To allow focus-stealing input, unset ${OPENSAFARI_HEADLESS_ONLY_ENV}.`,
          ] as const)
        : ([
              "Safari QA: call `set_active_context({ context: 'safari' })` to enable WebKitInputBackend",
              `Native apps: opt in to the CGEvent fallback by setting ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV}=1 ` +
                '(WARNING: will move the mouse cursor and bring Simulator.app to the foreground)',
            ] as const);
    const message =
      `No headless input backend available for device ${deviceId} (reason: ${reason}).\n` +
      remediation.map((line) => `  - ${line}`).join('\n');
    super(message);
    this.deviceId = deviceId;
    this.reason = reason;
    this.remediation = remediation;
    // Preserve prototype chain across the TypeScript down-compile
    Object.setPrototypeOf(this, HeadlessInputUnavailableError.prototype);
  }
}

// ── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Probe whether `simctl io input` is available by attempting a no-op tap at (0,0).
 * On Xcode 26+ this subcommand was removed and returns exit code 117.
 */
async function probeSimctlInput(deviceId: string): Promise<boolean> {
  const simctl = new SimctlExecutor();
  try {
    await simctl.exec(['io', deviceId, 'input', 'tap', '0', '0'], { timeout: 5000 });
    return true;
  } catch {
    console.error(
      '[input-backend] simctl io input unavailable (likely Xcode 26+ where this subcommand was removed)',
    );
    return false;
  }
}

/**
 * Attempt a single WebKit reconnect for a client that exists but reports
 * `isConnected() === false`. Returns true if the client is usable after the
 * attempt. Never throws — transient failures fall through to Tier 3.
 */
async function tryReconnectWebKit(client: BrowserBackend): Promise<boolean> {
  try {
    await client.connect();
    return client.isConnected();
  } catch (err) {
    console.error(
      `[input-backend] WebKit reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ── InputBackendResolver ──────────────────────────────────────────────────────

/**
 * Owns all backend detection state (simctl probe result, backend singletons,
 * Flutter VM cache). Create one instance per test or call `reset()` to clear
 * all cached state between runs.
 *
 * A module-level singleton is exported as `defaultResolver` for production use.
 */
export class InputBackendResolver {
  private simctlAvailable: boolean | null = null;
  private detectionPromise: Promise<boolean> | null = null;
  private cachedSimctlBackend: SimctlInputBackend | null = null;
  private cachedAppleScriptBackend: AppleScriptInputBackend | null = null;
  private focusInputOptInWarned = false;

  // SimulatorKit HID backend cache (Tier 1)
  private simHidProbed = false;
  private cachedSimHidBackend: InputBackend | null = null;

  // PointerService backend cache (opt-in, Phase 1 of #590)
  private pointerServiceProbed = false;
  private cachedPointerServiceBackend: InputBackend | null = null;

  private flutterResolver = new FlutterVMResolverInstance();

  /**
   * Get the input backend using a 4-tier fallback strategy with default-deny
   * hardening for the focus-stealing path.
   */
  async getInputBackend(
    deviceId: string,
    webkitClient?: BrowserBackend | null,
  ): Promise<InputBackend> {
    // Tier 0: Flutter VM Service (headless, no focus stealing, no opt-in).
    const flutterClient = await this.flutterResolver.resolve(deviceId);
    if (flutterClient) {
      return new FlutterVMInputBackend(flutterClient);
    }

    // Probe simctl once and cache the result
    if (this.simctlAvailable === null) {
      if (!this.detectionPromise) {
        this.detectionPromise = probeSimctlInput(deviceId).then((available) => {
          this.simctlAvailable = available;
          return available;
        });
      }
      await this.detectionPromise;
    }

    // Tier 1 (opt-in): PointerService backend — Phase 1 of #590.
    if (isPointerServiceEnabled()) {
      if (!this.pointerServiceProbed) {
        this.pointerServiceProbed = true;
        try {
          this.cachedPointerServiceBackend = await tryCreatePointerServiceBackend();
        } catch {
          this.cachedPointerServiceBackend = null;
        }
      }
      if (this.cachedPointerServiceBackend) {
        return this.cachedPointerServiceBackend;
      }
    }

    // Tier 1: SimulatorKit HID (headless, works with any app — all Xcode versions)
    if (!this.simHidProbed) {
      this.simHidProbed = true;
      try {
        this.cachedSimHidBackend = await tryCreateSimulatorKitHIDBackend();
      } catch {
        this.cachedSimHidBackend = null;
      }
    }
    if (this.cachedSimHidBackend) {
      return this.cachedSimHidBackend;
    }

    // Tier 2: simctl io input (headless, works with any app — Xcode ≤16)
    if (this.simctlAvailable) {
      if (!this.cachedSimctlBackend) {
        this.cachedSimctlBackend = new SimctlInputBackend();
      }
      return this.cachedSimctlBackend;
    }

    // Tier 2: WebKit JS touch injection (headless, Safari web content only).
    // If the client is present but disconnected, try a one-shot reconnect so
    // transient drops (proxy restart, tab churn) do not flip us to Tier 3.
    if (webkitClient) {
      if (webkitClient.isConnected()) {
        return new WebKitInputBackend(webkitClient);
      }
      const reconnected = await tryReconnectWebKit(webkitClient);
      if (reconnected) {
        return new WebKitInputBackend(webkitClient);
      }
    }

    // HEADLESS_ONLY safety net — block AppleScript fallback even if opt-in is set.
    if (isHeadlessOnly()) {
      if (isFocusInputAllowed()) {
        console.error(
          `[input-backend] ${OPENSAFARI_HEADLESS_ONLY_ENV}=1 overrides ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV} — AppleScript backend disabled`,
        );
      }
      const reason: HeadlessInputUnavailableError['reason'] = 'headless-only';
      const err = new HeadlessInputUnavailableError(deviceId, reason);
      console.error(`[input-backend] ${err.message}`);
      throw err;
    }

    // Tier 3: AppleScript/CGEvent fallback — DEFAULT-DENY.
    if (!isFocusInputAllowed()) {
      let reason: HeadlessInputUnavailableError['reason'];
      if (!webkitClient) {
        reason = 'no-webkit';
      } else {
        reason = 'webkit-disconnected';
      }
      const err = new HeadlessInputUnavailableError(deviceId, reason);
      console.error(`[input-backend] ${err.message}`);
      throw err;
    }

    if (!this.focusInputOptInWarned) {
      console.error(
        `[input-backend] ${OPENSAFARI_ALLOW_FOCUS_INPUT_ENV}=1 is set — ` +
          'AppleScript/CGEvent backend is enabled. ' +
          'This will move the physical mouse cursor and activate Simulator.app.',
      );
      this.focusInputOptInWarned = true;
    }

    if (!this.cachedAppleScriptBackend) {
      this.cachedAppleScriptBackend = new AppleScriptInputBackend();
    }
    return this.cachedAppleScriptBackend;
  }

  /**
   * Clear all cached state. Equivalent to constructing a fresh instance.
   * Exported for testing via the module-level `resetInputBackend()` shim.
   */
  reset(): void {
    this.simctlAvailable = null;
    this.detectionPromise = null;
    this.cachedSimctlBackend = null;
    this.cachedAppleScriptBackend = null;
    this.focusInputOptInWarned = false;
    this.simHidProbed = false;
    this.cachedSimHidBackend = null;
    this.pointerServiceProbed = false;
    this.cachedPointerServiceBackend = null;
    this.flutterResolver.reset();
  }

  /**
   * Override the Flutter VM resolver. Pass `null` to restore the default.
   * Intended for unit tests only — do not call from production code.
   */
  setFlutterVMResolver(resolver: FlutterVMResolver | null): void {
    this.flutterResolver.setResolver(resolver);
  }

  /**
   * Attempt to resolve a FlutterVMClient for this device. Returns null whenever
   * the device is not running a Flutter app in debug/profile mode. Never throws.
   *
   * Exposed so callers (e.g. routing diagnostics) can probe availability
   * without spinning up the full backend tier chain.
   */
  async tryGetFlutterVMClient(deviceId: string): Promise<import('../flutter').FlutterVMClient | null> {
    return this.flutterResolver.resolve(deviceId);
  }

  /**
   * Current number of entries in the Flutter VM discovery cache.
   * Exposed for the cache-budget survey (#554).
   */
  getFlutterClientCacheSize(): number {
    return this.flutterResolver.cacheSize();
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

/**
 * Default singleton resolver used by the compatibility shim in
 * `src/tools/native-input-backend.ts`. Production callers go through that
 * shim; tests that need isolation should construct their own `InputBackendResolver`.
 */
export const defaultResolver = new InputBackendResolver();
