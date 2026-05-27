/**
 * #801 PR2 — app_pop_until native fallback ladder tests.
 *
 * The ladder driver (`runNativeFallback`) and the per-step dispatcher
 * (`dispatchNativeBack`) are exercised against in-memory stubs of the
 * input backend and AX bridge so we can pin attempt-history shape,
 * strategy selection, and postcondition short-circuiting without a
 * real simulator.
 */

import { __forTests } from '../../src/tools/app-pop-until';

const { findBackAffordance, dispatchNativeBack, runNativeFallback } = __forTests;

function mockBridge(matchesByQuery: Array<{ q: Record<string, unknown>; matches: unknown[] }>) {
  return {
    query: jest.fn(async (q: Record<string, unknown>) => {
      const entry = matchesByQuery.find((m) =>
        Object.entries(m.q).every(([k, v]) => q[k] === v),
      );
      return { matches: entry ? entry.matches : [], total: entry?.matches.length ?? 0, query: q, ambiguous: false };
    }),
  };
}

function mockBackend(opts?: { failSwipe?: boolean; failKey?: boolean; tapImpl?: jest.Mock }) {
  return {
    tap: opts?.tapImpl ?? jest.fn(async () => undefined),
    swipe: jest.fn(async () => {
      if (opts?.failSwipe) throw new Error('swipe unavailable');
    }),
    sendKey: jest.fn(async () => {
      if (opts?.failKey) throw new Error('key unavailable');
    }),
    typeText: jest.fn(async () => undefined),
  };
}

describe('app_pop_until findBackAffordance (#801 PR2)', () => {
  it('returns the centre of the first identifier-hint match', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () =>
        mockBridge([
          {
            q: { identifier: 'back' },
            matches: [
              { role: 'AXButton', visible: true, enabled: true, frame: { x: 10, y: 50, width: 40, height: 40 } },
            ],
          },
        ]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const target = await reimported.findBackAffordance('DEV-1');
    expect(target).toEqual({ x: 30, y: 70, via: 'identifier=back' });
    jest.dontMock('../../src/native');
  });

  it('falls through identifier hints to label hints when none match', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () =>
        mockBridge([
          {
            q: { label: 'back' },
            matches: [
              { role: 'AXButton', visible: true, enabled: true, frame: { x: 0, y: 100, width: 60, height: 40 } },
              { role: 'AXStaticText', visible: true, enabled: true, frame: { x: 0, y: 90, width: 60, height: 20 } },
            ],
          },
        ]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const target = await reimported.findBackAffordance('DEV-1');
    // Should pick the AXButton over the AXStaticText.
    expect(target?.via).toBe('label=back');
    expect(target?.x).toBe(30);
    expect(target?.y).toBe(120);
    jest.dontMock('../../src/native');
  });

  it('returns null when nothing matches', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const target = await reimported.findBackAffordance('DEV-1');
    expect(target).toBeNull();
    jest.dontMock('../../src/native');
  });
});

describe('app_pop_until dispatchNativeBack (#801 PR2)', () => {
  it('taps the back affordance when AX finds one', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () =>
        mockBridge([
          {
            q: { identifier: 'back' },
            matches: [{ role: 'AXButton', visible: true, enabled: true, frame: { x: 0, y: 0, width: 40, height: 40 } }],
          },
        ]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const backend = mockBackend();
    const result = await reimported.dispatchNativeBack('DEV-1', backend as never);
    expect(result.strategy).toBe('native_back');
    expect(backend.tap).toHaveBeenCalledWith('DEV-1', 20, 20);
    expect(backend.swipe).not.toHaveBeenCalled();
    jest.dontMock('../../src/native');
  });

  it('falls through to edge_swipe when no back affordance is found', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const backend = mockBackend();
    const result = await reimported.dispatchNativeBack('DEV-1', backend as never);
    expect(result.strategy).toBe('edge_swipe');
    expect(backend.swipe).toHaveBeenCalled();
    expect(backend.tap).not.toHaveBeenCalled();
    jest.dontMock('../../src/native');
  });

  it('falls through to escape_key when swipe throws', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const backend = mockBackend({ failSwipe: true });
    const result = await reimported.dispatchNativeBack('DEV-1', backend as never);
    expect(result.strategy).toBe('escape_key');
    expect(backend.sendKey).toHaveBeenCalledWith('DEV-1', 'Escape');
    jest.dontMock('../../src/native');
  });

  it('throws when every native strategy fails', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const backend = mockBackend({ failSwipe: true, failKey: true });
    await expect(
      reimported.dispatchNativeBack('DEV-1', backend as never),
    ).rejects.toThrow(/all native strategies failed/);
    jest.dontMock('../../src/native');
  });
});

describe('app_pop_until runNativeFallback (#801 PR2)', () => {
  it('short-circuits when postcondition verifies after the first dispatch', async () => {
    jest.resetModules();
    // Single mock so both findBackAffordance and the postcondition poll
    // resolve through the same AX bridge.
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => ({
        query: jest.fn(async (q: Record<string, unknown>) => {
          if (q.identifier === 'back') {
            return {
              matches: [{ role: 'AXButton', visible: true, enabled: true, frame: { x: 0, y: 0, width: 40, height: 40 } }],
              total: 1,
              query: q,
              ambiguous: false,
            };
          }
          if (q.identifier === 'home_tab') {
            return { matches: [{ id: 'home' }], total: 1, query: q, ambiguous: false };
          }
          return { matches: [], total: 0, query: q, ambiguous: false };
        }),
      }),
    }));
    jest.doMock('../../src/tools/native-input-utils', () => ({
      getInputBackend: jest.fn(async () => mockBackend()),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const result = await reimported.runNativeFallback({
      deviceId: 'DEV-1',
      target: { until: 'first' },
      postSpec: { identifier: 'home_tab', timeoutMs: 500 },
      maxAttempts: 6,
      interAttemptDelayMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].ok).toBe(true);
    expect(result.postcondition.verified).toBe(true);
    jest.dontMock('../../src/native');
    jest.dontMock('../../src/tools/native-input-utils');
  });

  it('exhausts attempts when postcondition never verifies', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    jest.doMock('../../src/tools/native-input-utils', () => ({
      getInputBackend: jest.fn(async () => mockBackend()),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const result = await reimported.runNativeFallback({
      deviceId: 'DEV-1',
      target: { until: 'first' },
      postSpec: { identifier: 'never', timeoutMs: 50 },
      maxAttempts: 3,
      interAttemptDelayMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.attempts.length).toBe(3);
    jest.dontMock('../../src/native');
    jest.dontMock('../../src/tools/native-input-utils');
  });

  it('reports noBackend when getInputBackend throws', async () => {
    jest.resetModules();
    jest.doMock('../../src/tools/native-input-utils', () => ({
      getInputBackend: jest.fn(async () => {
        throw new Error('headless input unavailable');
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const result = await reimported.runNativeFallback({
      deviceId: 'DEV-1',
      target: { until: 'first' },
      postSpec: { identifier: 'home', timeoutMs: 50 },
      maxAttempts: 2,
      interAttemptDelayMs: 5,
    });
    expect(result.noBackend).toMatch(/headless input unavailable/);
    expect(result.attempts).toEqual([]);
    jest.dontMock('../../src/tools/native-input-utils');
  });

  it('caps attempts by count when target.until === "count"', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => mockBridge([]),
    }));
    jest.doMock('../../src/tools/native-input-utils', () => ({
      getInputBackend: jest.fn(async () => mockBackend()),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const result = await reimported.runNativeFallback({
      deviceId: 'DEV-1',
      target: { until: 'count', count: 2 },
      // Synthetic postcondition (matches the public handler's behavior when
      // no postcondition is supplied for until=count). It will never verify,
      // but the cap kicks in at count=2 anyway.
      postSpec: { identifier: '__opensafari_pop_until_count_synthetic__', timeoutMs: 30 },
      maxAttempts: 10,
      interAttemptDelayMs: 5,
    });
    expect(result.attempts.length).toBe(2);
    jest.dontMock('../../src/native');
    jest.dontMock('../../src/tools/native-input-utils');
  });
});
