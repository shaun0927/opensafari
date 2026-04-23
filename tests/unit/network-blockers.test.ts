/**
 * Unit tests for the simulator network-blocker abstraction layer
 * (issue #640, PR 2). No real system calls — all exec is mocked.
 */

import {
  AutoBlocker,
  HostExec,
  NetworkBlocker,
  NetworkBlockerNotImplementedError,
  NetworkBlockerUnavailableError,
  NlcBlocker,
  PFCTL_ANCHOR_NAME,
  PfctlBlocker,
} from '../../src/simulator/network-blockers';

function makeMockExec(): jest.Mocked<HostExec> {
  return { run: jest.fn().mockResolvedValue('') };
}

const DEVICE_ID = 'test-device-udid';

describe('PfctlBlocker', () => {
  it('reports kind "pfctl"', () => {
    const b = new PfctlBlocker({ exec: makeMockExec(), assumeAvailable: true });
    expect(b.kind).toBe('pfctl');
  });

  it('isAvailable returns true when sudo pfctl -sr succeeds', async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValueOnce('scrub in all');
    const b = new PfctlBlocker({ exec });
    await expect(b.isAvailable()).resolves.toBe(true);
    expect(exec.run).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/sbin/pfctl', '-sr'],
      expect.objectContaining({ timeoutMs: 2000 }),
    );
  });

  it('isAvailable returns false when sudo pfctl fails', async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValueOnce(new Error('sudo: a password is required'));
    const b = new PfctlBlocker({ exec });
    await expect(b.isAvailable()).resolves.toBe(false);
  });

  it('assumeAvailable bypasses probing', async () => {
    const exec = makeMockExec();
    const b = new PfctlBlocker({ exec, assumeAvailable: true });
    await expect(b.isAvailable()).resolves.toBe(true);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it('apply throws NetworkBlockerUnavailableError when mechanism is unavailable', async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValueOnce(new Error('sudo required'));
    const b = new PfctlBlocker({ exec });
    await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerUnavailableError);
  });

  it('apply throws NotImplemented in scaffold PR 2 even when available', async () => {
    const b = new PfctlBlocker({ exec: makeMockExec(), assumeAvailable: true });
    await expect(b.apply(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerNotImplementedError);
  });

  it('apply is idempotent when already active (no throw, no exec call)', async () => {
    const exec = makeMockExec();
    const b = new PfctlBlocker({ exec, assumeAvailable: true });
    b.__setActiveForTests(true);
    await expect(b.apply(DEVICE_ID)).resolves.toBeUndefined();
    expect(exec.run).not.toHaveBeenCalled();
  });

  it('revert is a no-op when nothing is active', async () => {
    const exec = makeMockExec();
    const b = new PfctlBlocker({ exec, assumeAvailable: true });
    await expect(b.revert(DEVICE_ID)).resolves.toBeUndefined();
    expect(exec.run).not.toHaveBeenCalled();
  });

  it('revert throws NotImplemented when active (scaffold)', async () => {
    const b = new PfctlBlocker({ exec: makeMockExec(), assumeAvailable: true });
    b.__setActiveForTests(true);
    await expect(b.revert(DEVICE_ID)).rejects.toBeInstanceOf(NetworkBlockerNotImplementedError);
  });

  it('status reports active+detail when active, inactive otherwise', async () => {
    const b = new PfctlBlocker({ exec: makeMockExec(), assumeAvailable: true });
    await expect(b.status()).resolves.toEqual({ active: false, activeSince: null, detail: null });
    b.__setActiveForTests(true, '2026-04-23T00:00:00.000Z');
    await expect(b.status()).resolves.toEqual({
      active: true,
      activeSince: '2026-04-23T00:00:00.000Z',
      detail: `pf anchor ${PFCTL_ANCHOR_NAME}`,
    });
  });

  it('anchorName option overrides the default anchor', async () => {
    const b = new PfctlBlocker({ exec: makeMockExec(), assumeAvailable: true, anchorName: 'custom' });
    b.__setActiveForTests(true);
    const s = await b.status();
    expect(s.detail).toBe('pf anchor custom');
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

  it('apply throws NotImplemented when NLC is available (scaffold)', async () => {
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
    // nlc was never probed once pfctl said yes
    expect((nlc.isAvailable as jest.Mock)).not.toHaveBeenCalled();
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
