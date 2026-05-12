/**
 * Compatibility re-export shim for `src/input/pointer-service-backend`.
 *
 * The implementation was moved to `src/input/pointer-service-backend.ts` as
 * part of the #707 (b) consolidation. This file re-exports every
 * previously-public symbol so existing callers (tests, tools) continue to
 * work without modification.
 *
 * New consumers should import directly from `../input/pointer-service-backend`.
 */

export {
  OPENSAFARI_ENABLE_POINTERSERVICE_ENV,
  isPointerServiceEnabled,
  PointerServiceInputBackend,
  tryCreatePointerServiceBackend,
} from '../input/pointer-service-backend';
