/**
 * Shared utilities for native app interaction tools.
 *
 * These helpers resolve the target simulator device and provide common
 * constants used by app_tap, app_type_text, app_swipe_native, etc.
 */

import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';
import type { InputBackend } from './native-input-backend';
import {
  captureInputTelemetry,
  isInputTelemetryMetaEnabled,
  type InputTelemetryEvent,
} from '../metrics/input-telemetry';

// Re-export input backend for tool files
export {
  getInputBackend,
  resetInputBackend,
  HeadlessInputUnavailableError,
  OPENSAFARI_ALLOW_FOCUS_INPUT_ENV,
  OPENSAFARI_HEADLESS_ONLY_ENV,
} from './native-input-backend';
export type { InputBackend, InputBackendKind } from './native-input-backend';
export {
  captureInputTelemetry,
  isInputTelemetryMetaEnabled,
  OPENSAFARI_INPUT_TELEMETRY_META_ENV,
} from '../metrics/input-telemetry';
export type { InputTelemetryEvent } from '../metrics/input-telemetry';

/**
 * Compact telemetry projection for the `_meta._telemetry` response field.
 * Drops `backendKind` / `deviceId` (already carried by the surrounding meta)
 * and retains the per-call signal that Epic #484's p50/p95/p99 rollups need.
 */
export interface InputTelemetryMeta {
  operation: string;
  elapsed_ms: number;
  ok: boolean;
  error?: string;
}

/** Shape returned by `buildInputMeta`. Kept explicit for call-site typing. */
export interface InputMeta {
  backendKind: string;
  headless: boolean;
  deviceId: string;
  _telemetry?: InputTelemetryMeta[];
}

function compactTelemetry(events: InputTelemetryEvent[]): InputTelemetryMeta[] {
  return events.map((e) => {
    const out: InputTelemetryMeta = {
      operation: e.operation,
      elapsed_ms: e.elapsed_ms,
      ok: e.ok,
    };
    if (e.error !== undefined) out.error = e.error;
    return out;
  });
}

/**
 * Build the `_meta` object that input tools include in their response
 * to expose which backend handled the operation. When a list of captured
 * telemetry events is supplied AND `OPENSAFARI_INPUT_TELEMETRY_META=1`, a
 * compact `_telemetry` projection is attached for per-call `elapsed_ms`.
 */
export function buildInputMeta(
  backend: InputBackend,
  deviceId: string,
  telemetry?: InputTelemetryEvent[],
): InputMeta {
  const meta: InputMeta = {
    backendKind: backend.kind,
    headless: backend.kind !== 'applescript',
    deviceId,
  };
  if (telemetry && telemetry.length > 0 && isInputTelemetryMetaEnabled()) {
    meta._telemetry = compactTelemetry(telemetry);
  }
  return meta;
}

/**
 * Run a backend operation and return its result plus a ready-to-embed
 * `_meta` object. When `OPENSAFARI_INPUT_TELEMETRY_META=1` the operation is
 * wrapped in a telemetry capture scope and the resulting events land under
 * `_meta._telemetry`. Otherwise the operation runs directly (zero overhead).
 *
 * This is the one-line integration path for MCP input tools: they call the
 * helper instead of invoking the backend method by hand, and the `_meta`
 * field carries the `_telemetry` projection automatically.
 */
export async function runInputOp<T>(
  backend: InputBackend,
  deviceId: string,
  op: () => Promise<T>,
): Promise<{ result: T; meta: InputMeta }> {
  if (!isInputTelemetryMetaEnabled()) {
    const result = await op();
    return { result, meta: buildInputMeta(backend, deviceId) };
  }
  const { result, events } = await captureInputTelemetry(op);
  return { result, meta: buildInputMeta(backend, deviceId, events) };
}

/**
 * Resolve the target device UDID from explicit param or the active device.
 * Throws a descriptive error when no device can be determined.
 */
export function resolveDeviceId(params: Record<string, unknown>): string {
  const deviceId =
    (params.deviceId as string | undefined) ||
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw new Error(
      'No device specified and no active device. Boot a simulator first with device_boot.',
    );
  }
  return deviceId;
}

/** Convenience factory — keeps tool files short. */
export function createSimctl(): SimctlExecutor {
  return new SimctlExecutor();
}

/**
 * USB HID key-code mapping used by `simctl io input keypress`.
 * Values are decimal USB HID usage codes.
 */
export const KEY_MAP: Record<string, string> = {
  return: '40',
  enter: '40',
  escape: '41',
  backspace: '42',
  delete: '42',
  tab: '43',
  space: '44',
  up: '82',
  down: '81',
  left: '80',
  right: '79',
  home: '74',
};
