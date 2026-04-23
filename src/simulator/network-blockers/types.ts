/**
 * Shared types for the simulator-level network blocking layer (issue #640).
 *
 * Each concrete backend (pfctl, Network Link Conditioner, …) implements
 * {@link NetworkBlocker}. The `device_network_set` / `device_network_get`
 * tools consume blockers through this interface only — they do not know
 * which mechanism is in use, so selection logic lives in `AutoBlocker`.
 *
 * This file is PR 2 (#640) and is intentionally side-effect-free:
 * concrete blockers accept an injectable {@link HostExec} so unit tests
 * can drive them with mocks. Real system calls land in PRs 3 / 4.
 */

export type NetworkBlockerKind = 'pfctl' | 'nlc';

export interface NetworkBlockerStatus {
  /** Whether this blocker currently has a rule installed. */
  active: boolean;
  /** ISO-8601 timestamp of the last successful `apply`, or null. */
  activeSince: string | null;
  /** Opaque detail string for diagnostics (e.g. anchor name, NLC profile). */
  detail: string | null;
}

export interface NetworkBlocker {
  readonly kind: NetworkBlockerKind;

  /**
   * Returns true if this mechanism is usable in the current environment.
   * Must not mutate system state. Implementations decide how to probe
   * (e.g. pfctl checks sudoers, nlc checks for installed preference pane).
   */
  isAvailable(): Promise<boolean>;

  /**
   * Install a block rule. Must be idempotent: calling `apply` twice in
   * a row is a no-op and must not accumulate rules.
   *
   * @param deviceId simulator UDID the block is associated with (the
   *   current mechanisms are host-wide, but the UDID is recorded for
   *   diagnostics and future per-device backends).
   */
  apply(deviceId: string): Promise<void>;

  /**
   * Remove the rule installed by `apply`. Must be idempotent:
   * calling `revert` with no rule present must succeed silently.
   */
  revert(deviceId: string): Promise<void>;

  /** Return the current blocker state for diagnostics / `device_network_get`. */
  status(): Promise<NetworkBlockerStatus>;
}

/**
 * Minimal shell-exec surface injected into blockers for testability.
 * Production code wires this to `child_process.execFile`; tests pass a mock.
 */
export interface HostExec {
  /**
   * Run a program with args and return stdout. Must reject with an Error
   * whose `.stderr` / `.code` fields match Node's child_process shape on
   * non-zero exit, so blockers can pattern-match on the cause.
   */
  run(cmd: string, args: string[], options?: HostExecOptions): Promise<string>;
}

export interface HostExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** If true, non-zero exit is returned as {stdout, code, stderr} instead of throwing. */
  allowNonZero?: boolean;
}

export class NetworkBlockerUnavailableError extends Error {
  constructor(kind: NetworkBlockerKind, reason: string) {
    super(`network blocker "${kind}" is unavailable: ${reason}`);
    this.name = 'NetworkBlockerUnavailableError';
  }
}

export class NetworkBlockerNotImplementedError extends Error {
  constructor(kind: NetworkBlockerKind, op: 'apply' | 'revert') {
    super(
      `network blocker "${kind}" ${op}() is not wired yet — tracked in issue #640 (PR ${kind === 'pfctl' ? '3' : '4'})`,
    );
    this.name = 'NetworkBlockerNotImplementedError';
  }
}
