/**
 * Compatibility re-export shim for `src/input/flutter-vm-backend`.
 *
 * The implementation was moved to `src/input/flutter-vm-backend.ts` as part
 * of the #707 (b) consolidation. This file re-exports every previously-public
 * symbol so existing callers (tests, tools) continue to work without
 * modification.
 *
 * New consumers should import directly from `../input/flutter-vm-backend`.
 */

export {
  FlutterVMInputBackendError,
  FlutterVMInputBackend,
} from '../input/flutter-vm-backend';

export type { FlutterVMInputBackendErrorCode } from '../input/flutter-vm-backend';
