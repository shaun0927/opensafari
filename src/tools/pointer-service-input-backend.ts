/**
 * PointerServiceInputBackend — Phase 1 opt-in wrapper around the
 * `sim-hid-bridge tap-ps` subcommand for Xcode 26+ coordinate tap.
 *
 * Motivation (issue #590): Apple dropped `IndigoHIDMessageForMouseNSEvent`
 * handling in CoreSimulator on Xcode 26. The Tier-1 SimulatorKitHID bare
 * mouse path has therefore been gated off for tap/swipe, forcing
 * coordinate-based `app_tap` / `app_swipe_native` to fall through to the
 * focus-stealing AppleScript / CGEvent backend. The PointerService probe
 * shipped in #555 wraps the same mouse events with
 * `IndigoHIDMessageToCreatePointerService` / `RemovePointerService`
 * brackets; the synthesis doc (#557) falsified this as a *fix*, but it
 * remains the most-likely-to-help interim stop-gap because:
 *
 *   - It requires no simulator-side changes.
 *   - Telemetry is cheap to collect under an opt-in flag.
 *   - If field data shows ≥ 99 % success, #590 Phase 2 promotes it to the
 *     default Tier-1 path.
 *
 * Status: **opt-in experimental**. Activated only when
 * `OPENSAFARI_ENABLE_POINTERSERVICE=1` is set. Defaults off so CI that
 * has already adapted to the AppleScript fallback is unaffected.
 *
 * Scope: only `tap` is routed through the `tap-ps` subcommand. The Swift
 * bridge does not yet expose `swipe-ps`; swipe / typeText / keypress /
 * sendKey delegate to the underlying `SimulatorKitHIDInputBackend`, which
 * keeps non-tap input paths on their existing (keyboard-safe) Tier-1
 * route. On Xcode 26+ that delegated SimHID swipe path is itself gated
 * off and throws `HeadlessInputUnavailableError`; the PointerService
 * backend is cached as the selected backend by `getInputBackend`, so the
 * throw does NOT re-enter the tier chain. See the comment on `swipe()`
 * below and issue #649 for the caller-visible contract. Extending
 * `sim-hid-bridge` with pointer-service-bracketed swipe and promoting
 * the backend to the default chain are tracked as Phase 2 follow-ups in
 * #590.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { InputBackend } from './native-input-backend';
import {
  SimulatorKitHIDInputBackend,
  InputBackendError,
} from './sim-hid-input-backend';
import { timedInput } from '../metrics/input-telemetry';

/**
 * Env flag that enables the PointerService backend (Phase 1 opt-in).
 * Accepted values: `1`, `true`. Anything else is ignored.
 */
export const OPENSAFARI_ENABLE_POINTERSERVICE_ENV =
  'OPENSAFARI_ENABLE_POINTERSERVICE';

export function isPointerServiceEnabled(): boolean {
  const value = process.env[OPENSAFARI_ENABLE_POINTERSERVICE_ENV];
  return value === '1' || value === 'true';
}

/**
 * PointerService tap + delegated swipe/keys.
 *
 * Composes a `SimulatorKitHIDInputBackend` for the subset of methods that
 * still share the default `sim-hid-bridge` subcommand set, and shells out
 * directly to `sim-hid-bridge <udid> tap-ps ...` for `tap`.
 */
export class PointerServiceInputBackend implements InputBackend {
  readonly kind = 'pointer-service' as const;

  constructor(
    private readonly bridgePath: string,
    private readonly delegate: SimulatorKitHIDInputBackend,
  ) {}

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      const args = [deviceId, 'tap-ps', String(x), String(y)];
      if (duration !== undefined && duration > 0) {
        args.push(String(duration));
      }
      await runTapPs(this.bridgePath, args);
    });
  }

  async swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void> {
    // Phase 1: no swipe-ps subcommand exists yet. Delegate straight to the
    // underlying SimulatorKitHIDInputBackend. On Xcode 26+ the `sim-hid-bridge
    // swipe` subcommand exits with `SIMULATORKIT_UNAVAILABLE` (or another
    // non-zero SimulatorKit code), and the delegate surfaces that to the caller
    // as an `InputBackendError` — not `HeadlessInputUnavailableError`, which is
    // produced one layer up in `native-input-backend.getInputBackend` when
    // selecting a backend, never from a backend's own swipe() method.
    //
    // That error does NOT re-enter the tier chain because
    // PointerServiceInputBackend is cached as the selected backend in
    // getInputBackend once OPENSAFARI_ENABLE_POINTERSERVICE=1 resolves it. For
    // completeness, any other error type the delegate may raise in the future
    // is also passed through unchanged; see the "swipe propagates … without
    // wrapping" tests for the frozen contract.
    //
    // Callers that need swipe fallback on Xcode 26+ must either (a) leave
    // OPENSAFARI_ENABLE_POINTERSERVICE unset so the standard Tier-1 SimHID /
    // focus-input chain is selected for every call, or (b) invoke an
    // element-targeted swipe so the AX-press tier handles the gesture.
    // Promoting this to a real in-tool tier downgrade is tracked under #590
    // Phase 2 alongside `sim-hid-bridge swipe-ps`. See #649 for the decision
    // record.
    await this.delegate.swipe(deviceId, startX, startY, endX, endY, duration);
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await this.delegate.typeText(deviceId, text);
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await this.delegate.keypress(deviceId, keyCode);
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await this.delegate.sendKey(deviceId, keyName);
  }

  /**
   * Batching is not supported on PointerServiceInputBackend. The `tap-ps`
   * subcommand is Phase 1 experimental (opt-in via
   * `OPENSAFARI_ENABLE_POINTERSERVICE=1`); batching is deferred to Phase 2
   * of #590 alongside the `swipe-ps` subcommand. Callers that need repeated
   * taps via the pointer-service path must invoke `tap()` in a loop.
   */
  supportsBatching(): boolean {
    return false;
  }
}

/**
 * Execute `sim-hid-bridge` with the given argv. Mirrors the spawn/parse
 * contract of `SimulatorKitHIDInputBackend.run` but is narrowed to the
 * single `tap-ps` subcommand used by the PointerService backend, so the
 * failure-handling path stays local and auditable.
 */
async function runTapPs(bridgePath: string, args: string[]): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const isSwiftSource = bridgePath.endsWith('.swift');
  const cmd = isSwiftSource ? 'swift' : bridgePath;
  const cmdArgs = isSwiftSource ? [bridgePath, ...args] : args;

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(cmd, cmdArgs, {
      timeout: 10_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    const exit = typeof e.code === 'number' ? e.code : undefined;
    const hint = stderr.trim() || stdout.trim() || e.message;
    throw new InputBackendError(
      `sim-hid-bridge tap-ps exited ${exit ?? '?'}: ${hint}`,
      'UNKNOWN',
      stderr,
    );
  }

  if (!stdout.trim()) return;
  try {
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string };
    if (parsed.ok === false) {
      throw new InputBackendError(
        parsed.error ?? 'sim-hid-bridge tap-ps reported ok=false',
        'UNKNOWN',
        stderr,
      );
    }
  } catch (err) {
    if (err instanceof InputBackendError) throw err;
    const safeStdout = stdout
      .slice(0, 200)
      .replace(/[\x00-\x1f\x7f]/g, '?');
    throw new InputBackendError(
      `sim-hid-bridge tap-ps produced non-JSON stdout: ${safeStdout}`,
      'JSON_PARSE_FAILURE',
      stderr,
    );
  }
}

/**
 * Factory mirroring `tryCreateSimulatorKitHIDBackend`: locate a usable
 * `sim-hid-bridge` helper and wrap it as a `PointerServiceInputBackend`.
 * Returns `null` when the helper is not installed — callers are expected
 * to fall through to the default SimHID tier.
 */
export async function tryCreatePointerServiceBackend(): Promise<PointerServiceInputBackend | null> {
  const candidates = [
    path.resolve(__dirname, '..', 'sim-hid-bridge'),
    path.resolve(__dirname, 'sim-hid-bridge'),
    path.resolve(__dirname, '..', 'sim-hid-bridge.swift'),
    path.resolve(__dirname, 'sim-hid-bridge.swift'),
  ];
  if (process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER === '1') {
    candidates.push(
      path.resolve(__dirname, '..', '..', 'src', 'native', 'sim-hid-bridge.swift'),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const delegate = new SimulatorKitHIDInputBackend(candidate);
      return new PointerServiceInputBackend(candidate, delegate);
    }
  }
  return null;
}
