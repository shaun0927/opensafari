/**
 * Compatibility re-export shim for `src/input/sim-hid-backend`.
 *
 * The implementation was moved to `src/input/sim-hid-backend.ts` as part of
 * the #707 (b) consolidation. This file re-exports every previously-public
 * symbol so existing callers (tests, tools) continue to work without
 * modification.
 *
 * New consumers should import directly from `../input/sim-hid-backend`.
 */

export {
  resetSimHidPrivateAPIWarning,
  InputBackendError,
  SimulatorKitHIDInputBackend,
  tryCreateSimulatorKitHIDBackend,
} from '../input/sim-hid-backend';

export type { InputBackendErrorCode } from '../input/sim-hid-backend';
