/**
 * Unit tests for PR8 — SessionManager.rehydrateFromSimctl.
 *
 * Verifies the manager re-registers any simulator simctl reports as booted,
 * is idempotent, swallows lookup failures gracefully, and honours the
 * presetLookup hook for accurate viewport dimensions.
 */

import { SessionManager } from '../../src/session-manager';

describe('SessionManager.rehydrateFromSimctl', () => {
  it('registers each booted device with sensible defaults', async () => {
    const sm = new SessionManager();
    const lookup = {
      listBooted: jest.fn().mockResolvedValue([
        { udid: 'DEV-A', name: 'iPhone 16' },
        { udid: 'DEV-B', name: 'iPad Pro 11-inch' },
      ]),
    };

    const result = await sm.rehydrateFromSimctl(lookup);

    expect(result.rehydrated).toEqual(['DEV-A', 'DEV-B']);
    expect(result.skipped).toEqual([]);
    expect(sm.listSimulators().map((s) => s.deviceId)).toEqual(['DEV-A', 'DEV-B']);
    expect(sm.getSimulator('DEV-A')?.state).toBe('booted');
  });

  it('honours presetLookup for viewport dimensions', async () => {
    const sm = new SessionManager();
    const lookup = {
      listBooted: jest.fn().mockResolvedValue([{ udid: 'DEV-A', name: 'iPhone 16' }]),
    };
    const presetLookup = (name: string) =>
      name === 'iPhone 16' ? { w: 393, h: 852 } : undefined;

    await sm.rehydrateFromSimctl(lookup, { presetLookup });

    expect(sm.getSimulator('DEV-A')?.viewport).toEqual({ width: 393, height: 852 });
  });

  it('skips devices already known to the SessionManager (idempotent)', async () => {
    const sm = new SessionManager();
    sm.addSimulator('DEV-A', {
      deviceId: 'DEV-A',
      deviceType: 'iPhone 16',
      state: 'booted',
      viewport: { width: 100, height: 200 },
      bootedAt: 1,
      lastActivity: 1,
    });
    const lookup = {
      listBooted: jest.fn().mockResolvedValue([
        { udid: 'DEV-A', name: 'iPhone 16' },
        { udid: 'DEV-B', name: 'iPhone 16' },
      ]),
    };

    const result = await sm.rehydrateFromSimctl(lookup);

    expect(result.rehydrated).toEqual(['DEV-B']);
    expect(result.skipped).toEqual(['DEV-A']);
    // Pre-existing viewport must NOT be clobbered.
    expect(sm.getSimulator('DEV-A')?.viewport).toEqual({ width: 100, height: 200 });
  });

  it('returns empty + logs when simctl lookup throws', async () => {
    const sm = new SessionManager();
    const lookup = {
      listBooted: jest.fn().mockRejectedValue(new Error('simctl missing')),
    };

    const result = await sm.rehydrateFromSimctl(lookup);

    expect(result.rehydrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(sm.listSimulators()).toEqual([]);
  });
});
