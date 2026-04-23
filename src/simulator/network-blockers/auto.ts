/**
 * AutoBlocker — picks pfctl first (reliable, deterministic) and falls back
 * to NLC when pfctl is unavailable (no passwordless sudoers rule).
 *
 * Selection is lazy: the first `isAvailable()`, `apply()`, or `status()`
 * call chooses and caches a backend. Subsequent calls route to the same
 * backend unless `reset()` is called (used by tests).
 */

import { NetworkBlocker, NetworkBlockerStatus, NetworkBlockerUnavailableError } from './types';

export interface AutoBlockerOptions {
  /** Ordered list of candidates; the first available one wins. */
  candidates: NetworkBlocker[];
}

export class AutoBlocker implements NetworkBlocker {
  readonly kind = 'pfctl' as const; // placeholder; actual kind is reported by the selected backend via status().detail
  private readonly candidates: NetworkBlocker[];
  private selected: NetworkBlocker | null = null;

  constructor(opts: AutoBlockerOptions) {
    if (!opts.candidates.length) {
      throw new Error('AutoBlocker requires at least one candidate');
    }
    this.candidates = opts.candidates;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.select()) !== null;
  }

  async apply(deviceId: string): Promise<void> {
    const backend = await this.requireBackend();
    return backend.apply(deviceId);
  }

  async revert(deviceId: string): Promise<void> {
    if (!this.selected) {
      // Nothing to revert — caller asked for a revert before any apply.
      return;
    }
    return this.selected.revert(deviceId);
  }

  async status(): Promise<NetworkBlockerStatus> {
    if (!this.selected) {
      return { active: false, activeSince: null, detail: null };
    }
    return this.selected.status();
  }

  /** Return the selected backend's kind, or null if selection has not run yet. */
  selectedKind(): NetworkBlocker['kind'] | null {
    return this.selected?.kind ?? null;
  }

  /** Test-only: clear the cached selection so the next call re-probes. */
  reset(): void {
    this.selected = null;
  }

  private async select(): Promise<NetworkBlocker | null> {
    if (this.selected) return this.selected;
    for (const c of this.candidates) {
      if (await c.isAvailable()) {
        this.selected = c;
        return c;
      }
    }
    return null;
  }

  private async requireBackend(): Promise<NetworkBlocker> {
    const backend = await this.select();
    if (!backend) {
      throw new NetworkBlockerUnavailableError(
        'pfctl',
        'no candidate backend is available on this host (tried: ' +
          this.candidates.map((c) => c.kind).join(', ') +
          '). Install Network Link Conditioner or configure passwordless pfctl sudo — see docs/tools/device-network.md (PR 5).',
      );
    }
    return backend;
  }
}
