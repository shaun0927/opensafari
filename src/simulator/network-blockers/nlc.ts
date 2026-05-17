/**
 * NlcBlocker — fallback backend that *would* drive Network Link
 * Conditioner's 100% Loss profile, but ships as an intentional stub.
 *
 * Why it's a stub (see `docs/tools/device-network.md` §Network Link
 * Conditioner for the long version): NLC has no public macOS CLI for
 * enable/disable. `defaults write` only edits prefs; the filter is
 * activated via a prefPane that uses a private Network Extension on
 * macOS 11+. Programmatic control requires either UI scripting (too
 * brittle — every macOS UI refresh breaks it) or a signed Network
 * Extension we ship ourselves (out of scope).
 *
 * The blocker is kept wired in the {@link AutoBlocker} candidate list
 * so callers that explicitly pass `mechanism: "nlc"` get a structured
 * `NlcUnsupportedError` pointing at the doc, rather than silent
 * success. The `isAvailable()` probe still honours the prefPane
 * presence so the auto-selector can tell "NLC installed but
 * unsupported here" from "NLC not installed at all".
 */

import {
  HostExec,
  NetworkBlocker,
  NetworkBlockerStatus,
  NetworkBlockerUnavailableError,
} from './types';

export const NLC_PREF_PANE = '/Library/PreferencePanes/Network Link Conditioner.prefPane';

/**
 * Raised when a caller explicitly requests the NLC mechanism. Separate
 * from {@link NetworkBlockerNotImplementedError} so consumers can
 * distinguish "temporarily unwired" from "structurally unsupported on
 * current macOS" and surface the right guidance.
 */
export class NlcUnsupportedError extends Error {
  constructor(op: 'apply' | 'revert') {
    super(
      `Network Link Conditioner ${op}() is not wired: macOS has no public CLI to enable/disable NLC. ` +
        `Use mechanism: "pfctl" instead — see docs/tools/device-network.md#network-link-conditioner-nlc.`,
    );
    this.name = 'NlcUnsupportedError';
  }
}

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
        `Network Link Conditioner is not installed at ${this.prefPanePath}; install via Xcode's "Additional Tools for Xcode" package, then re-run with mechanism: "pfctl" for actual blocking (see docs/tools/device-network.md)`,
      );
    }
    if (this.active) return;
    throw new NlcUnsupportedError('apply');
  }

  async revert(_deviceId: string): Promise<void> {
    if (!this.active) return;
    throw new NlcUnsupportedError('revert');
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
