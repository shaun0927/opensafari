/**
 * NlcBlocker — stub for the Network Link Conditioner fallback. PR 2 only
 * wires the interface skeleton; real profile activation lands in PR 4.
 */

import {
  HostExec,
  NetworkBlocker,
  NetworkBlockerNotImplementedError,
  NetworkBlockerStatus,
  NetworkBlockerUnavailableError,
} from './types';

const NLC_PREF_PANE = '/Library/PreferencePanes/Network Link Conditioner.prefPane';

export interface NlcBlockerOptions {
  exec: HostExec;
  /** Force availability answer for tests. */
  assumeAvailable?: boolean;
  /** Override the path we probe for NLC installation. */
  prefPanePath?: string;
}

export class NlcBlocker implements NetworkBlocker {
  readonly kind = 'nlc' as const;
  private readonly exec: HostExec;
  private readonly assumeAvailable?: boolean;
  private readonly prefPanePath: string;
  private active = false;
  private activeSince: string | null = null;

  constructor(opts: NlcBlockerOptions) {
    this.exec = opts.exec;
    this.assumeAvailable = opts.assumeAvailable;
    this.prefPanePath = opts.prefPanePath ?? NLC_PREF_PANE;
  }

  async isAvailable(): Promise<boolean> {
    if (this.assumeAvailable !== undefined) return this.assumeAvailable;
    try {
      await this.exec.run('/bin/test', ['-d', this.prefPanePath], { timeoutMs: 1000 });
      return true;
    } catch {
      return false;
    }
  }

  async apply(_deviceId: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new NetworkBlockerUnavailableError(
        'nlc',
        `Network Link Conditioner is not installed at ${this.prefPanePath}; install via Xcode's "Additional Tools for Xcode" package`,
      );
    }
    if (this.active) return;
    throw new NetworkBlockerNotImplementedError('nlc', 'apply');
  }

  async revert(_deviceId: string): Promise<void> {
    if (!this.active) return;
    throw new NetworkBlockerNotImplementedError('nlc', 'revert');
  }

  async status(): Promise<NetworkBlockerStatus> {
    return {
      active: this.active,
      activeSince: this.activeSince,
      detail: this.active ? 'Network Link Conditioner profile "100% Loss"' : null,
    };
  }

  __setActiveForTests(active: boolean, sinceIso: string | null = null): void {
    this.active = active;
    this.activeSince = active ? sinceIso ?? new Date().toISOString() : null;
  }
}
