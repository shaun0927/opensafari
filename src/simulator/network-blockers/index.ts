/**
 * Public surface for the simulator network-blocker layer (issue #640).
 *
 * Consumers should import from this module only, so future mechanism
 * additions don't require call-site churn.
 */

export { AutoBlocker } from './auto';
export type { AutoBlockerOptions } from './auto';
export { NlcBlocker } from './nlc';
export type { NlcBlockerOptions } from './nlc';
export { PfctlBlocker, PFCTL_ANCHOR_NAME } from './pfctl';
export type { PfctlBlockerOptions } from './pfctl';
export { RealHostExec } from './host-exec';
export type {
  HostExec,
  HostExecOptions,
  NetworkBlocker,
  NetworkBlockerKind,
  NetworkBlockerStatus,
} from './types';
export {
  NetworkBlockerNotImplementedError,
  NetworkBlockerUnavailableError,
} from './types';
