/**
 * #801 PR1 — app_pop_until contract extension tests.
 *
 * Pin the new helpers (parsePostcondition, verifyAxPostcondition,
 * verifyRoutePostcondition) and the response-shape contract that
 * downstream consumers will rely on.
 */

import { __forTests } from '../../src/tools/app-pop-until';

const { parsePostcondition } = __forTests;

describe('app_pop_until parsePostcondition (#801 PR1)', () => {
  it('returns null when no postcondition is supplied', () => {
    expect(parsePostcondition(undefined)).toBeNull();
    expect(parsePostcondition(null)).toBeNull();
  });

  it('accepts a spec with at least one signal field', () => {
    expect(parsePostcondition({ identifier: 'home_tab' })).toEqual({ identifier: 'home_tab' });
    expect(parsePostcondition({ label: 'Home' })).toEqual({ label: 'Home' });
    expect(parsePostcondition({ route: '/home' })).toEqual({ route: '/home' });
    expect(parsePostcondition({ role: 'button' })).toEqual({ role: 'button' });
  });

  it('rejects a spec with no signal fields', () => {
    expect(() => parsePostcondition({})).toThrow(/at least one/);
    expect(() => parsePostcondition({ timeoutMs: 1000 })).toThrow(/at least one/);
  });

  it('rejects non-object specs', () => {
    expect(() => parsePostcondition('home_tab')).toThrow(/object/);
    expect(() => parsePostcondition(42)).toThrow(/object/);
  });
});

describe('app_pop_until VM path verifyRoutePostcondition (#801 PR1)', () => {
  const { verifyRoutePostcondition } = __forTests;

  it('returns verified=true when ModalRoute name matches', async () => {
    // We can exercise the VM helper directly with a stubbed flutter client.
    // The helper resolves the client via getFlutterVMClient, so we wire a
    // module-level stub for this test.
    jest.resetModules();
    jest.doMock('../../src/flutter', () => ({
      getFlutterVMClient: () => ({
        evaluate: async () => ({ valueAsString: 'opensafari_route:ok' }),
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const verdict = await reimported.verifyRoutePostcondition('DEV-1', '/home', 1000, 50);
    expect(verdict.verified).toBe(true);
    expect(verdict.route).toBe('/home');
    expect(verdict.kind).toBe('route');
    jest.dontMock('../../src/flutter');
  });

  it('returns verified=false with a finite poll count when the deadline expires', async () => {
    jest.resetModules();
    jest.doMock('../../src/flutter', () => ({
      getFlutterVMClient: () => ({
        evaluate: async () => ({ valueAsString: 'opensafari_route:mismatch:/other' }),
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const verdict = await reimported.verifyRoutePostcondition('DEV-1', '/home', 200, 50);
    expect(verdict.verified).toBe(false);
    expect(verdict.kind).toBe('route');
    expect((verdict.polls ?? 0)).toBeGreaterThanOrEqual(1);
    jest.dontMock('../../src/flutter');
  });

  it('surfaces VM evaluate errors in the last error field', async () => {
    jest.resetModules();
    jest.doMock('../../src/flutter', () => ({
      getFlutterVMClient: () => ({
        evaluate: async () => {
          throw new Error('isolate paused');
        },
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const verdict = await reimported.verifyRoutePostcondition('DEV-1', '/home', 100, 50);
    expect(verdict.verified).toBe(false);
    expect(verdict.error).toMatch(/isolate paused/);
    jest.dontMock('../../src/flutter');
  });
});

describe('app_pop_until VM path verifyAxPostcondition (#801 PR1)', () => {
  const { verifyAxPostcondition } = __forTests;

  it('reports verified=true on first non-empty AX match', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => ({
        query: async () => ({ matches: [{ id: 'home_tab' }] }),
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const verdict = await reimported.verifyAxPostcondition(
      'DEV-1',
      { identifier: 'home_tab' },
      1000,
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.kind).toBe('ax_query');
    expect(verdict.finalMatchCount).toBe(1);
    jest.dontMock('../../src/native');
  });

  it('returns verified=false with finalMatchCount=0 when AX never matches', async () => {
    jest.resetModules();
    jest.doMock('../../src/native', () => ({
      getAccessibilityBridge: () => ({
        query: async () => ({ matches: [] }),
      }),
    }));
    const { __forTests: reimported } = await import('../../src/tools/app-pop-until');
    const verdict = await reimported.verifyAxPostcondition(
      'DEV-1',
      { identifier: 'never_matches' },
      150,
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.finalMatchCount).toBe(0);
    expect((verdict.polls ?? 0)).toBeGreaterThanOrEqual(1);
    jest.dontMock('../../src/native');
  });
});
