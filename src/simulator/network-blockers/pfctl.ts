/**
 * PfctlBlocker — installs a dedicated `pf` anchor that drops all
 * non-loopback outbound traffic, so iOS Simulator apps (which share
 * the host's network stack) see deterministic `SocketException` /
 * `NSURLErrorNotConnectedToInternet` failures.
 *
 * Issue #640, PR 3 wires the real `pfctl` calls on top of the PR 2
 * interface. Crash-safe cleanup / startup reconciliation is PR 4;
 * the NLC fallback is PR 5.
 *
 * Prerequisites (documented in PR 5 / `docs/tools/device-network.md`):
 *   - `/etc/pf.conf` references the anchor:
 *       anchor "opensafari-simdevnet"
 *   - `/etc/sudoers.d/opensafari` grants passwordless pfctl:
 *       <user> ALL=(root) NOPASSWD: /sbin/pfctl
 *   - pf is enabled on the host (`sudo pfctl -E`).
 *
 * Without these, `apply()` surfaces a structured error rather than
 * silently loading rules that never fire.
 */

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
    public readonly op: 'apply' | 'revert' | 'probe',
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(`pfctl ${op} failed (exit ${exitCode ?? '?'}): ${stderr.trim() || '(no stderr)'}`);
    this.name = 'PfctlCommandError';
  }
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
}

export class PfctlBlocker implements NetworkBlocker {
  readonly kind = 'pfctl' as const;
  private readonly exec: HostExec;
  private readonly tempFile: TempFileWriter;
  private readonly assumeAvailable: boolean;
  private readonly anchor: string;
  private readonly rules: string;
  private readonly nowFn: () => Date;
  private active = false;
  private activeSince: string | null = null;

  constructor(opts: PfctlBlockerOptions) {
    this.exec = opts.exec;
    this.tempFile = opts.tempFile;
    this.assumeAvailable = opts.assumeAvailable === true;
    this.anchor = opts.anchorName ?? PFCTL_ANCHOR_NAME;
    this.rules = opts.rules ?? PFCTL_BLOCK_RULES;
    this.nowFn = opts.now ?? (() => new Date());
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
  }

  async status(): Promise<NetworkBlockerStatus> {
    return {
      active: this.active,
      activeSince: this.activeSince,
      detail: this.active ? `pf anchor ${this.anchor}` : null,
    };
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

  private wrapExecError(op: 'apply' | 'revert' | 'probe', err: unknown): PfctlCommandError {
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
}
