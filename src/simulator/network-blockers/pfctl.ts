/**
 * PfctlBlocker — installs a dedicated `pf` anchor that drops all
 * non-loopback outbound traffic, so iOS Simulator apps (which share
 * the host's network stack) see deterministic `SocketException` /
 * `NSURLErrorNotConnectedToInternet` failures.
 *
 * Issue #640 PR sequence:
 *   - PR 3: real `pfctl` apply/revert on top of the PR 2 interface.
 *   - PR 4 (this PR): crash-safe cleanup + startup reconciliation.
 *   - PR 5: NLC fallback + host setup docs.
 *
 * Prerequisites (documented in PR 5 / `docs/tools/device-network.md`):
 *   - `/etc/pf.conf` references the anchor:
 *       anchor "opensafari-simdevnet"
 *   - `/etc/sudoers.d/opensafari` grants passwordless pfctl:
 *       <user> ALL=(root) NOPASSWD: /sbin/pfctl
 *   - pf is enabled on the host (`sudo pfctl -E`).
 */

import { CleanupRegistry, cleanupRegistry as defaultRegistry } from './cleanup';
import {
  HostExec,
  NetworkBlocker,
  NetworkBlockerStatus,
  NetworkBlockerUnavailableError,
  TempFileWriter,
} from './types';

export const PFCTL_ANCHOR_NAME = 'opensafari-simdevnet';

/**
 * pf rules loaded into the anchor. Blocks all non-loopback outbound
 * traffic so URLSession / dart:io HttpClient calls from the simulator
 * fail immediately. Loopback is preserved so localhost IPC (webkit
 * proxy, MCP stdio) keeps working while the block is active.
 */
export const PFCTL_BLOCK_RULES = [
  '# opensafari #640: simulator-bound network block',
  'block drop out on ! lo0 all',
  '',
].join('\n');

export class PfctlPfDisabledError extends Error {
  constructor() {
    super(
      'pf is not enabled on this host; run "sudo pfctl -E" or follow the one-time setup in docs/tools/device-network.md to enable pf and install the opensafari-simdevnet anchor',
    );
    this.name = 'PfctlPfDisabledError';
  }
}

export class PfctlCommandError extends Error {
  constructor(
    public readonly op: 'apply' | 'revert' | 'probe' | 'reconcile',
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(`pfctl ${op} failed (exit ${exitCode ?? '?'}): ${stderr.trim() || '(no stderr)'}`);
    this.name = 'PfctlCommandError';
  }
}

/** Result surfaced by {@link PfctlBlocker.reconcileStaleAnchor}. */
export interface PfctlReconcileResult {
  /** Whether reconciliation found leftover rules and flushed them. */
  reconciled: boolean;
  /** Number of non-empty rule lines observed in the anchor. */
  rulesFound: number;
  /** Non-fatal reason reconciliation did nothing (e.g. probe skipped). */
  skippedReason?: 'unavailable' | 'probe_failed' | 'anchor_empty';
}

export interface PfctlBlockerOptions {
  exec: HostExec;
  tempFile: TempFileWriter;
  /**
   * When true, `isAvailable()` resolves true without probing (used by tests).
   * In production, availability is decided by whether `sudo -n pfctl -sr`
   * succeeds without a password prompt.
   */
  assumeAvailable?: boolean;
  /** Override anchor name for tests. */
  anchorName?: string;
  /** Override the rule body for tests. */
  rules?: string;
  /** Time provider for deterministic tests. */
  now?: () => Date;
  /**
   * Injectable cleanup registry. Default is the shared process-wide
   * singleton; tests pass a scoped registry so unit tests don't touch
   * real process signals.
   */
  cleanup?: CleanupRegistry;
}

export class PfctlBlocker implements NetworkBlocker {
  readonly kind = 'pfctl' as const;
  private readonly exec: HostExec;
  private readonly tempFile: TempFileWriter;
  private readonly assumeAvailable: boolean;
  private readonly anchor: string;
  private readonly rules: string;
  private readonly nowFn: () => Date;
  private readonly cleanup: CleanupRegistry;
  private active = false;
  private activeSince: string | null = null;
  private unregisterCleanup: (() => void) | null = null;

  constructor(opts: PfctlBlockerOptions) {
    this.exec = opts.exec;
    this.tempFile = opts.tempFile;
    this.assumeAvailable = opts.assumeAvailable === true;
    this.anchor = opts.anchorName ?? PFCTL_ANCHOR_NAME;
    this.rules = opts.rules ?? PFCTL_BLOCK_RULES;
    this.nowFn = opts.now ?? (() => new Date());
    this.cleanup = opts.cleanup ?? defaultRegistry;
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
        'sudo pfctl requires a passwordless sudoers rule; see docs/tools/device-network.md',
      );
    }
    if (this.active) return; // idempotent

    await this.assertPfEnabled();

    const rulesPath = await this.tempFile.write(this.rules);
    try {
      try {
        await this.exec.run(
          '/usr/bin/sudo',
          ['-n', '/sbin/pfctl', '-a', this.anchor, '-f', rulesPath],
          { timeoutMs: 5000 },
        );
      } catch (err) {
        throw this.wrapExecError('apply', err);
      }
      this.active = true;
      this.activeSince = this.nowFn().toISOString();
      this.registerCleanupHandler();
    } finally {
      await this.tempFile.remove(rulesPath).catch(() => undefined);
    }
  }

  async revert(_deviceId: string): Promise<void> {
    if (!this.active) return; // idempotent
    try {
      await this.exec.run(
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', this.anchor, '-F', 'all'],
        { timeoutMs: 5000 },
      );
    } catch (err) {
      throw this.wrapExecError('revert', err);
    }
    this.active = false;
    this.activeSince = null;
    this.unregisterCleanupHandler();
  }

  async status(): Promise<NetworkBlockerStatus> {
    return {
      active: this.active,
      activeSince: this.activeSince,
      detail: this.active ? `pf anchor ${this.anchor}` : null,
    };
  }

  /**
   * Probe our anchor for leftover rules and flush them. Intended to be
   * called exactly once at server start so a prior run that died before
   * reverting (SIGKILL, OOM, host crash) doesn't leave the user's
   * network broken.
   *
   * Best-effort: any probe/flush failure is swallowed and returned as
   * a `skippedReason` rather than thrown — reconciliation should never
   * block server startup.
   */
  async reconcileStaleAnchor(): Promise<PfctlReconcileResult> {
    if (!(await this.isAvailable())) {
      return { reconciled: false, rulesFound: 0, skippedReason: 'unavailable' };
    }

    let stdout: string;
    try {
      stdout = await this.exec.run(
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', this.anchor, '-sr'],
        { timeoutMs: 2000, allowNonZero: true },
      );
    } catch {
      return { reconciled: false, rulesFound: 0, skippedReason: 'probe_failed' };
    }

    const rulesFound = countRuleLines(stdout);
    if (rulesFound === 0) {
      return { reconciled: false, rulesFound: 0, skippedReason: 'anchor_empty' };
    }

    try {
      await this.exec.run(
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', this.anchor, '-F', 'all'],
        { timeoutMs: 5000 },
      );
    } catch (err) {
      throw this.wrapExecError('reconcile', err);
    }
    return { reconciled: true, rulesFound };
  }

  private async assertPfEnabled(): Promise<void> {
    let stdout: string;
    try {
      stdout = await this.exec.run('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-s', 'info'], {
        timeoutMs: 2000,
      });
    } catch (err) {
      throw this.wrapExecError('probe', err);
    }
    // macOS `pfctl -s info` prints e.g. "Status: Enabled for 12 days ..." or "Status: Disabled".
    if (!/Status:\s*Enabled/i.test(stdout)) {
      throw new PfctlPfDisabledError();
    }
  }

  private registerCleanupHandler(): void {
    if (this.unregisterCleanup) return;
    this.unregisterCleanup = this.cleanup.add(async () => {
      // Best-effort flush during shutdown. Errors are swallowed by the
      // registry itself; the next server start will reconcile anything
      // we missed.
      try {
        await this.exec.run(
          '/usr/bin/sudo',
          ['-n', '/sbin/pfctl', '-a', this.anchor, '-F', 'all'],
          { timeoutMs: 5000 },
        );
      } catch {
        // Swallow — startup reconciliation is the authoritative path.
      }
    });
  }

  private unregisterCleanupHandler(): void {
    if (this.unregisterCleanup) {
      this.unregisterCleanup();
      this.unregisterCleanup = null;
    }
  }

  private wrapExecError(
    op: 'apply' | 'revert' | 'probe' | 'reconcile',
    err: unknown,
  ): PfctlCommandError {
    const e = err as { stderr?: string; code?: number; message?: string };
    const stderr = e.stderr ?? e.message ?? '';
    const code = typeof e.code === 'number' ? e.code : null;
    return new PfctlCommandError(op, stderr, code);
  }

  /** Test-only helper to inject state without going through apply(). */
  __setActiveForTests(active: boolean, sinceIso: string | null = null): void {
    this.active = active;
    this.activeSince = active ? sinceIso ?? new Date().toISOString() : null;
  }

  /** Test-only: observe whether a cleanup handler is currently registered. */
  __hasCleanupHandlerForTests(): boolean {
    return this.unregisterCleanup !== null;
  }
}

/**
 * Count non-empty, non-comment rule lines in `pfctl -sr` output.
 * Comments start with `#`; blank lines are ignored. This keeps the
 * `skippedReason: 'anchor_empty'` branch deterministic across pfctl
 * output shapes (some versions emit a trailing comment on empty anchors).
 */
function countRuleLines(stdout: string): number {
  if (!stdout) return 0;
  let n = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    n += 1;
  }
  return n;
}
