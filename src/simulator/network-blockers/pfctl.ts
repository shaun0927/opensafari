/**
 * PfctlBlocker — stub that will install/remove a dedicated `pf` anchor to
 * block simulator-bound traffic at the host level. Issue #640, PR 2 only
 * wires the interface and an in-memory state machine; the real anchor
 * rules land in PR 3.
 */

import {
  HostExec,
  NetworkBlocker,
  NetworkBlockerNotImplementedError,
  NetworkBlockerStatus,
  NetworkBlockerUnavailableError,
} from './types';

export const PFCTL_ANCHOR_NAME = 'opensafari-simdevnet';

export interface PfctlBlockerOptions {
  exec: HostExec;
  /**
   * When true, `isAvailable()` resolves true without probing (used by tests).
   * In production, availability is decided by whether `sudo -n pfctl -sr`
   * succeeds without a password prompt.
   */
  assumeAvailable?: boolean;
  /** Override anchor name for tests. */
  anchorName?: string;
}

export class PfctlBlocker implements NetworkBlocker {
  readonly kind = 'pfctl' as const;
  private readonly exec: HostExec;
  private readonly assumeAvailable: boolean;
  private readonly anchor: string;
  private active = false;
  private activeSince: string | null = null;

  constructor(opts: PfctlBlockerOptions) {
    this.exec = opts.exec;
    this.assumeAvailable = opts.assumeAvailable === true;
    this.anchor = opts.anchorName ?? PFCTL_ANCHOR_NAME;
  }

  async isAvailable(): Promise<boolean> {
    if (this.assumeAvailable) return true;
    try {
      await this.exec.run('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-sr'], {
        timeoutMs: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async apply(_deviceId: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new NetworkBlockerUnavailableError(
        'pfctl',
        'sudo pfctl requires a passwordless sudoers rule; see docs/tools/device-network.md (pending PR 5)',
      );
    }
    if (this.active) return; // idempotent
    // Real anchor install lands in PR 3.
    // For PR 2 we deliberately raise NotImplemented so CI surfaces the
    // missing backend rather than silently "blocking" traffic.
    throw new NetworkBlockerNotImplementedError('pfctl', 'apply');
  }

  async revert(_deviceId: string): Promise<void> {
    if (!this.active) return; // idempotent
    throw new NetworkBlockerNotImplementedError('pfctl', 'revert');
  }

  async status(): Promise<NetworkBlockerStatus> {
    return {
      active: this.active,
      activeSince: this.activeSince,
      detail: this.active ? `pf anchor ${this.anchor}` : null,
    };
  }

  /** Test-only helper to inject state without going through apply(). */
  __setActiveForTests(active: boolean, sinceIso: string | null = null): void {
    this.active = active;
    this.activeSince = active ? sinceIso ?? new Date().toISOString() : null;
  }
}
