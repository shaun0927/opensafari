/**
 * Public surface for the simulator network-blocker layer (issue #640).
 *
 * Consumers should import from this module only, so future mechanism
 * additions don't require call-site churn.
 */

export { AutoBlocker } from './auto';
export type { AutoBlockerOptions } from './auto';
export { cleanupRegistry, NodeCleanupRegistry } from './cleanup';
export type { CleanupFn, CleanupRegistry } from './cleanup';
export { NLC_PREF_PANE, NlcBlocker, NlcUnsupportedError } from './nlc';
export type { NlcBlockerOptions } from './nlc';
export {
  PFCTL_ANCHOR_NAME,
  PFCTL_BLOCK_RULES,
  PfctlBlocker,
  PfctlCommandError,
  PfctlPfDisabledError,
} from './pfctl';
export type { PfctlBlockerOptions, PfctlReconcileResult } from './pfctl';
export { RealHostExec } from './host-exec';
export { RealTempFileWriter } from './temp-file';
export type { RealTempFileWriterOptions } from './temp-file';
export type {
  HostExec,
  HostExecOptions,
  NetworkBlocker,
  NetworkBlockerKind,
  NetworkBlockerStatus,
  TempFileWriter,
} from './types';
export {
  NetworkBlockerNotImplementedError,
  NetworkBlockerUnavailableError,
} from './types';
