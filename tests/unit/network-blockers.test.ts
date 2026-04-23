/**
 * Unit tests for the simulator network-blocker abstraction layer
 * (issue #640). No real system calls — all exec and temp-file I/O is
 * mocked. PR 3 wires pfctl to real pfctl commands; NLC is still
 * scaffold and raises NotImplemented until PR 5.
 */

import {
  AutoBlocker,
  HostExec,
  NetworkBlocker,
  NetworkBlockerNotImplementedError,
  NetworkBlockerUnavailableError,
  NlcBlocker,
  NodeCleanupRegistry,
  PFCTL_ANCHOR_NAME,
  PFCTL_BLOCK_RULES,
  PfctlBlocker,
  PfctlCommandError,
  PfctlPfDisabledError,
  TempFileWriter,
} from '../../src/simulator/network-blockers';

function makeMockExec(): jest.Mocked<HostExec> {
  return { run: jest.fn().mockResolvedValue('') };
}

function makeMockTempFile(
  fixedPath = '/tmp/opensafari-pfctl-mock/rules.conf',
): jest.Mocked<TempFileWriter> {
  return {
    write: jest.fn<Promise<string>, [string]>().mockResolvedValue(fixedPath),
    remove: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
}

const DEVICE_ID = 'test-device-udid';
const PF_INFO_ENABLED = 'Status: Enabled for 12 days 03:45:12                Debug: Urgent\n';
const PF_INFO_DISABLED = 'Status: Disabled\n';

describe('PfctlBlocker', () => {
  it('reports kind "pfctl"', () => {
    const b = new PfctlBlocker({
      exec: makeMockExec(),
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
    });
    expect(b.kind).toBe('pfctl');
  });

  describe('isAvailable', () => {
    it('returns true when sudo pfctl -sr succeeds', async () => {
      const exec = makeMockExec();
      exec.run.mockResolvedValueOnce('scrub in all');
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile() });
      await expect(b.isAvailable()).resolves.toBe(true);
      expect(exec.run).toHaveBeenCalledWith(
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-sr'],
        expect.objectContaining({ timeoutMs: 2000 }),
      );
    });

    it('returns false when sudo pfctl fails', async () => {
      const exec = makeMockExec();
      exec.run.mockRejectedValueOnce(new Error('sudo: a password is required'));
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile() });
      await expect(b.isAvailable()).resolves.toBe(false);
    });

    it('assumeAvailable bypasses probing', async () => {
      const exec = makeMockExec();
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile(), assumeAvailable: true });
      await expect(b.isAvailable()).resolves.toBe(true);
      expect(exec.run).not.toHaveBeenCalled();
    });
  });

  describe('apply (PR 3 real backend)', () => {
    it('throws NetworkBlockerUnavailableError when mechanism is unavailable', async () => {
      const exec = makeMockExec();
      exec.run.mockRejectedValueOnce(new Error('sudo required'));
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile() });
      await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerUnavailableError);
    });

    it('throws PfctlPfDisabledError when pf is disabled', async () => {
      const exec = makeMockExec();
      exec.run.mockResolvedValueOnce(PF_INFO_DISABLED); // assertPfEnabled
      const b = new PfctlBlocker({
        exec,
        tempFile: makeMockTempFile(),
        assumeAvailable: true,
      });
      await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(PfctlPfDisabledError);
    });

    it('writes rules to a temp file and loads them into the anchor', async () => {
      const exec = makeMockExec();
      exec.run
        .mockResolvedValueOnce(PF_INFO_ENABLED) // assertPfEnabled
        .mockResolvedValueOnce(''); // pfctl -a ... -f ...
      const tempFile = makeMockTempFile('/tmp/opensafari-pfctl-xyz/rules.conf');
      const now = () => new Date('2026-04-23T18:00:00.000Z');
      const b = new PfctlBlocker({ exec, tempFile, assumeAvailable: true, now });

      await b.apply(DEVICE_ID);

      expect(tempFile.write).toHaveBeenCalledWith(PFCTL_BLOCK_RULES);
      expect(exec.run).toHaveBeenCalledTimes(2);
      expect(exec.run).toHaveBeenNthCalledWith(
        1,
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-s', 'info'],
        expect.objectContaining({ timeoutMs: 2000 }),
      );
      expect(exec.run).toHaveBeenNthCalledWith(
        2,
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', PFCTL_ANCHOR_NAME, '-f', '/tmp/opensafari-pfctl-xyz/rules.conf'],
        expect.objectContaining({ timeoutMs: 5000 }),
      );
      expect(tempFile.remove).toHaveBeenCalledWith('/tmp/opensafari-pfctl-xyz/rules.conf');

      const s = await b.status();
      expect(s.active).toBe(true);
      expect(s.activeSince).toBe('2026-04-23T18:00:00.000Z');
      expect(s.detail).toBe(`pf anchor ${PFCTL_ANCHOR_NAME}`);
    });

    it('honors custom anchor name and rules body', async () => {
      const exec = makeMockExec();
      exec.run.mockResolvedValueOnce(PF_INFO_ENABLED).mockResolvedValueOnce('');
      const tempFile = makeMockTempFile();
      const b = new PfctlBlocker({
        exec,
        tempFile,
        assumeAvailable: true,
        anchorName: 'custom-anchor',
        rules: 'block drop out all',
      });
      await b.apply(DEVICE_ID);
      expect(tempFile.write).toHaveBeenCalledWith('block drop out all');
      expect(exec.run).toHaveBeenNthCalledWith(
        2,
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', 'custom-anchor', '-f', expect.any(String)],
        expect.anything(),
      );
    });

    it('is idempotent when already active (no exec, no temp file)', async () => {
      const exec = makeMockExec();
      const tempFile = makeMockTempFile();
      const b = new PfctlBlocker({ exec, tempFile, assumeAvailable: true });
      b.__setActiveForTests(true);
      await expect(b.apply(DEVICE_ID)).resolves.toBeUndefined();
      expect(exec.run).not.toHaveBeenCalled();
      expect(tempFile.write).not.toHaveBeenCalled();
    });

    it('wraps pfctl exec failures in PfctlCommandError and still cleans the temp file', async () => {
      const exec = makeMockExec();
      const pfctlErr = Object.assign(new Error('pfctl: No such file'), {
        stderr: 'pfctl: No such file',
        code: 1,
      });
      exec.run.mockResolvedValueOnce(PF_INFO_ENABLED).mockRejectedValueOnce(pfctlErr);
      const tempFile = makeMockTempFile();
      const b = new PfctlBlocker({ exec, tempFile, assumeAvailable: true });

      await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(PfctlCommandError);
      expect(tempFile.remove).toHaveBeenCalled(); // cleanup on error
      const s = await b.status();
      expect(s.active).toBe(false); // state rollback
    });
  });

  describe('revert (PR 3 real backend)', () => {
    it('is a no-op when nothing is active', async () => {
      const exec = makeMockExec();
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile(), assumeAvailable: true });
      await expect(b.revert(DEVICE_ID)).resolves.toBeUndefined();
      expect(exec.run).not.toHaveBeenCalled();
    });

    it('flushes the anchor when active', async () => {
      const exec = makeMockExec();
      exec.run.mockResolvedValueOnce('');
      const b = new PfctlBlocker({
        exec,
        tempFile: makeMockTempFile(),
        assumeAvailable: true,
        anchorName: 'test-anchor',
      });
      b.__setActiveForTests(true);
      await b.revert(DEVICE_ID);
      expect(exec.run).toHaveBeenCalledWith(
        '/usr/bin/sudo',
        ['-n', '/sbin/pfctl', '-a', 'test-anchor', '-F', 'all'],
        expect.objectContaining({ timeoutMs: 5000 }),
      );
      const s = await b.status();
      expect(s.active).toBe(false);
      expect(s.activeSince).toBeNull();
    });

    it('wraps pfctl revert failures in PfctlCommandError and leaves state active', async () => {
      const exec = makeMockExec();
      exec.run.mockRejectedValueOnce(
        Object.assign(new Error('pfctl: permission denied'), {
          stderr: 'pfctl: permission denied',
          code: 2,
        }),
      );
      const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile(), assumeAvailable: true });
      b.__setActiveForTests(true);
      await expect(b.revert(DEVICE_ID)).rejects.toBeInstanceOf(PfctlCommandError);
      const s = await b.status();
      expect(s.active).toBe(true); // did not clear; caller can retry
    });
  });

  describe('status', () => {
    it('reports inactive by default', async () => {
      const b = new PfctlBlocker({
        exec: makeMockExec(),
        tempFile: makeMockTempFile(),
        assumeAvailable: true,
      });
      await expect(b.status()).resolves.toEqual({ active: false, activeSince: null, detail: null });
    });

    it('reports active+detail after __setActiveForTests', async () => {
      const b = new PfctlBlocker({
        exec: makeMockExec(),
        tempFile: makeMockTempFile(),
        assumeAvailable: true,
      });
      b.__setActiveForTests(true, '2026-04-23T00:00:00.000Z');
      await expect(b.status()).resolves.toEqual({
        active: true,
        activeSince: '2026-04-23T00:00:00.000Z',
        detail: `pf anchor ${PFCTL_ANCHOR_NAME}`,
      });
    });

    it('anchorName option overrides the default anchor in detail', async () => {
      const b = new PfctlBlocker({
        exec: makeMockExec(),
        tempFile: makeMockTempFile(),
        assumeAvailable: true,
        anchorName: 'custom',
      });
      b.__setActiveForTests(true);
      const s = await b.status();
      expect(s.detail).toBe('pf anchor custom');
    });
  });
});

describe('NlcBlocker', () => {
  it('reports kind "nlc"', () => {
    const b = new NlcBlocker({ exec: makeMockExec(), assumeAvailable: true });
    expect(b.kind).toBe('nlc');
  });

  it('isAvailable true when /bin/test -d succeeds', async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValueOnce('');
    const b = new NlcBlocker({ exec, prefPanePath: '/tmp/fake.prefPane' });
    await expect(b.isAvailable()).resolves.toBe(true);
    expect(exec.run).toHaveBeenCalledWith(
      '/bin/test',
      ['-d', '/tmp/fake.prefPane'],
      expect.objectContaining({ timeoutMs: 1000 }),
    );
  });

  it('isAvailable false when /bin/test -d fails', async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValueOnce(new Error('no such directory'));
    const b = new NlcBlocker({ exec });
    await expect(b.isAvailable()).resolves.toBe(false);
  });

  it('assumeAvailable=false short-circuits probing to false', async () => {
    const exec = makeMockExec();
    const b = new NlcBlocker({ exec, assumeAvailable: false });
    await expect(b.isAvailable()).resolves.toBe(false);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it('apply throws NetworkBlockerUnavailableError when NLC is missing', async () => {
    const b = new NlcBlocker({ exec: makeMockExec(), assumeAvailable: false });
    await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerUnavailableError);
  });

  it('apply throws NotImplemented when NLC is available (scaffold; impl lands in PR 5)', async () => {
    const b = new NlcBlocker({ exec: makeMockExec(), assumeAvailable: true });
    await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerNotImplementedError);
  });

  it('status surfaces the NLC profile name when active', async () => {
    const b = new NlcBlocker({ exec: makeMockExec(), assumeAvailable: true });
    b.__setActiveForTests(true);
    const s = await b.status();
    expect(s.detail).toMatch(/100% Loss/);
    expect(s.active).toBe(true);
  });
});

describe('AutoBlocker selection order', () => {
  function makeBackend(kind: 'pfctl' | 'nlc', available: boolean): NetworkBlocker {
    return {
      kind,
      isAvailable: jest.fn().mockResolvedValue(available),
      apply: jest.fn().mockResolvedValue(undefined),
      revert: jest.fn().mockResolvedValue(undefined),
      status: jest.fn().mockResolvedValue({ active: false, activeSince: null, detail: kind }),
    };
  }

  it('throws when no candidates provided', () => {
    expect(() => new AutoBlocker({ candidates: [] })).toThrow(/at least one candidate/);
  });

  it('picks the first available candidate (pfctl first)', async () => {
    const pfctl = makeBackend('pfctl', true);
    const nlc = makeBackend('nlc', true);
    const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
    await auto.isAvailable();
    expect(auto.selectedKind()).toBe('pfctl');
    expect(nlc.isAvailable as jest.Mock).not.toHaveBeenCalled();
  });

  it('falls back to NLC when pfctl is unavailable', async () => {
    const pfctl = makeBackend('pfctl', false);
    const nlc = makeBackend('nlc', true);
    const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
    await auto.isAvailable();
    expect(auto.selectedKind()).toBe('nlc');
  });

  it('reports unavailable and throws on apply when every candidate is unavailable', async () => {
    const pfctl = makeBackend('pfctl', false);
    const nlc = makeBackend('nlc', false);
    const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
    await expect(auto.isAvailable()).resolves.toBe(false);
    await expect(auto.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerUnavailableError);
  });

  it('caches the selected backend across calls', async () => {
    const pfctl = makeBackend('pfctl', true);
    const nlc = makeBackend('nlc', true);
    const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
    await auto.isAvailable();
    await auto.status();
    await auto.apply(DEVICE_ID);
    expect((pfctl.isAvailable as jest.Mock).mock.calls.length).toBe(1);
    expect(pfctl.apply).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('reset() clears the cached selection so the next call re-probes', async () => {
    const pfctl = makeBackend('pfctl', true);
    const auto = new AutoBlocker({ candidates: [pfctl] });
    await auto.isAvailable();
    expect((pfctl.isAvailable as jest.Mock).mock.calls.length).toBe(1);
    auto.reset();
    await auto.isAvailable();
    expect((pfctl.isAvailable as jest.Mock).mock.calls.length).toBe(2);
  });

  it('revert is a no-op when no backend was ever selected (no apply yet)', async () => {
    const pfctl = makeBackend('pfctl', true);
    const auto = new AutoBlocker({ candidates: [pfctl] });
    await expect(auto.revert(DEVICE_ID)).resolves.toBeUndefined();
    expect(pfctl.revert).not.toHaveBeenCalled();
  });

  it('revert delegates to the selected backend after apply', async () => {
    const pfctl = makeBackend('pfctl', true);
    const auto = new AutoBlocker({ candidates: [pfctl] });
    await auto.apply(DEVICE_ID);
    await auto.revert(DEVICE_ID);
    expect(pfctl.revert).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('status returns inactive before any selection', async () => {
    const pfctl = makeBackend('pfctl', true);
    const auto = new AutoBlocker({ candidates: [pfctl] });
    await expect(auto.status()).resolves.toEqual({
      active: false,
      activeSince: null,
      detail: null,
    });
  });
});

describe('PfctlBlocker.reconcileStaleAnchor (PR 4)', () => {
  it('returns skippedReason="unavailable" when the mechanism cannot be probed', async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValueOnce(new Error('sudo required'));
    const b = new PfctlBlocker({ exec, tempFile: makeMockTempFile() });
    await expect(b.reconcileStaleAnchor()).resolves.toEqual({
      reconciled: false,
      rulesFound: 0,
      skippedReason: 'unavailable',
    });
  });

  it('returns skippedReason="anchor_empty" when no rules are present', async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValueOnce(''); // pfctl -a <anchor> -sr yields nothing
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
    });
    const result = await b.reconcileStaleAnchor();
    expect(result).toEqual({ reconciled: false, rulesFound: 0, skippedReason: 'anchor_empty' });
    // only one exec call — no flush attempted
    expect(exec.run).toHaveBeenCalledTimes(1);
  });

  it('ignores comment/blank lines when counting rules', async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValueOnce('# some header\n\n# another comment\n');
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
    });
    const result = await b.reconcileStaleAnchor();
    expect(result.skippedReason).toBe('anchor_empty');
  });

  it('flushes when leftover rules are detected and returns reconciled:true', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('block drop out on ! lo0 all\n') // sr probe
      .mockResolvedValueOnce(''); // flush
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
      anchorName: 'test-anchor',
    });
    const result = await b.reconcileStaleAnchor();
    expect(result).toEqual({ reconciled: true, rulesFound: 1 });
    expect(exec.run).toHaveBeenCalledTimes(2);
    expect(exec.run).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/sudo',
      ['-n', '/sbin/pfctl', '-a', 'test-anchor', '-F', 'all'],
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('wraps flush failures in PfctlCommandError with op="reconcile"', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('block drop out on ! lo0 all\n')
      .mockRejectedValueOnce(
        Object.assign(new Error('pfctl: not root'), {
          stderr: 'pfctl: not root',
          code: 1,
        }),
      );
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
    });
    await expect(b.reconcileStaleAnchor()).rejects.toBeInstanceOf(PfctlCommandError);
  });

  it('returns skippedReason="probe_failed" when the probe itself throws', async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValueOnce(new Error('sudo timeout'));
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
    });
    const result = await b.reconcileStaleAnchor();
    expect(result).toEqual({
      reconciled: false,
      rulesFound: 0,
      skippedReason: 'probe_failed',
    });
  });
});

describe('PfctlBlocker cleanup registration (PR 4)', () => {
  it('registers a cleanup handler on successful apply', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('Status: Enabled\n') // assertPfEnabled
      .mockResolvedValueOnce(''); // pfctl load
    const cleanup = new NodeCleanupRegistry();
    cleanup.disableForTests();
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
      cleanup,
    });

    expect(cleanup.size()).toBe(0);
    await b.apply(DEVICE_ID);
    expect(cleanup.size()).toBe(1);
    expect(b.__hasCleanupHandlerForTests()).toBe(true);
  });

  it('unregisters the cleanup handler on successful revert', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('Status: Enabled\n')
      .mockResolvedValueOnce('') // apply
      .mockResolvedValueOnce(''); // revert
    const cleanup = new NodeCleanupRegistry();
    cleanup.disableForTests();
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
      cleanup,
    });
    await b.apply(DEVICE_ID);
    expect(cleanup.size()).toBe(1);
    await b.revert(DEVICE_ID);
    expect(cleanup.size()).toBe(0);
    expect(b.__hasCleanupHandlerForTests()).toBe(false);
  });

  it('keeps the cleanup handler registered when revert fails', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('Status: Enabled\n')
      .mockResolvedValueOnce('') // apply
      .mockRejectedValueOnce(
        Object.assign(new Error('pfctl revert failed'), {
          stderr: 'err',
          code: 1,
        }),
      );
    const cleanup = new NodeCleanupRegistry();
    cleanup.disableForTests();
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
      cleanup,
    });
    await b.apply(DEVICE_ID);
    expect(cleanup.size()).toBe(1);
    await expect(b.revert(DEVICE_ID)).rejects.toBeInstanceOf(PfctlCommandError);
    // Still registered — caller can retry and cleanup will fire on shutdown.
    expect(cleanup.size()).toBe(1);
  });

  it('fired cleanup handler issues a flush against the anchor', async () => {
    const exec = makeMockExec();
    exec.run
      .mockResolvedValueOnce('Status: Enabled\n')
      .mockResolvedValueOnce('') // apply
      .mockResolvedValueOnce(''); // flush via cleanup
    const cleanup = new NodeCleanupRegistry();
    cleanup.disableForTests();
    const b = new PfctlBlocker({
      exec,
      tempFile: makeMockTempFile(),
      assumeAvailable: true,
      anchorName: 'cleanup-test',
      cleanup,
    });
    await b.apply(DEVICE_ID);
    await cleanup.fireForTests();
    expect(exec.run).toHaveBeenLastCalledWith(
      '/usr/bin/sudo',
      ['-n', '/sbin/pfctl', '-a', 'cleanup-test', '-F', 'all'],
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });
});
