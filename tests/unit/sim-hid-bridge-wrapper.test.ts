import {
  applyTransitionalPromotion,
  normalizeMaxSettleRetries,
  type ProbeResult,
  type WrapperProbeFlags,
} from '../../src/tools/sim-hid-bridge-wrapper';

const EXPECTED = 'com.opensafari.fixtures.flutterSpinnerQa';

function unavailable(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    classification: 'FOREGROUND_CONTEXT_UNAVAILABLE',
    verified: false,
    runningApps: [{ bundleId: EXPECTED, pid: 1234 }],
    warnings: [],
    ...overrides,
  };
}

function flags(overrides: Partial<WrapperProbeFlags> = {}): WrapperProbeFlags {
  return { expectBundle: EXPECTED, settleMs: 800, maxSettleRetries: 1, ...overrides };
}

describe('normalizeMaxSettleRetries', () => {
  it('clamps values to the {0,1,2,3} range', () => {
    expect(normalizeMaxSettleRetries(-1)).toBe(0);
    expect(normalizeMaxSettleRetries(0)).toBe(0);
    expect(normalizeMaxSettleRetries(1)).toBe(1);
    expect(normalizeMaxSettleRetries(3)).toBe(3);
    expect(normalizeMaxSettleRetries(99)).toBe(3);
  });

  it('falls back to the default for non-number / NaN input', () => {
    expect(normalizeMaxSettleRetries('1' as unknown)).toBe(1);
    expect(normalizeMaxSettleRetries(undefined)).toBe(1);
    expect(normalizeMaxSettleRetries(Number.NaN)).toBe(1);
  });
});

describe('applyTransitionalPromotion (sim-hid-bridge wrapper — issue #46)', () => {
  it('promotes to TRANSITIONAL_STATE_TIMEOUT when two UNAVAILABLE probes see the expected bundle running', async () => {
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(unavailable());

    const result = await applyTransitionalPromotion(unavailable(), flags(), reprobe);

    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(result.classification).toBe('TRANSITIONAL_STATE_TIMEOUT');
    expect(result.verified).toBe(false);
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes('transitional timeout'))).toBe(true);
    expect(warnings.some((w) => w.includes(EXPECTED))).toBe(true);
    // totalMs = 2 * 800ms
    expect(warnings.some((w) => w.includes('1600ms'))).toBe(true);
  });

  it('lets the second result win when the re-probe resolves to a non-UNAVAILABLE classification', async () => {
    const second: ProbeResult = {
      classification: 'APP_CONTENT_UNVERIFIED',
      verified: false,
      runningApps: [{ bundleId: EXPECTED, pid: 1234 }],
      warnings: ['something else'],
    };
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(second);

    const result = await applyTransitionalPromotion(unavailable(), flags(), reprobe);

    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(result.classification).toBe('APP_CONTENT_UNVERIFIED');
    expect(result.warnings).toEqual(['something else']);
  });

  it('does NOT promote when the expected bundle is not in runningApps (truly unknown foreground)', async () => {
    const first = unavailable({ runningApps: [] });
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(unavailable());

    const result = await applyTransitionalPromotion(first, flags(), reprobe);

    expect(reprobe).not.toHaveBeenCalled();
    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
  });

  it('does NOT promote when no --expect-bundle is supplied', async () => {
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(unavailable());

    const result = await applyTransitionalPromotion(
      unavailable(),
      flags({ expectBundle: undefined }),
      reprobe,
    );

    expect(reprobe).not.toHaveBeenCalled();
    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
  });

  it('opt-out: --max-settle-retries 0 skips the re-probe entirely', async () => {
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(unavailable());

    const result = await applyTransitionalPromotion(
      unavailable(),
      flags({ maxSettleRetries: 0 }),
      reprobe,
    );

    expect(reprobe).not.toHaveBeenCalled();
    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
  });

  it('short-circuits when the first probe already returned a non-UNAVAILABLE classification', async () => {
    const first: ProbeResult = {
      classification: 'TARGET_BUNDLE_CONFIRMED',
      verified: true,
      runningApps: [{ bundleId: EXPECTED, pid: 1234 }],
      warnings: [],
    };
    const reprobe = jest.fn<Promise<ProbeResult>, []>().mockResolvedValue(unavailable());

    const result = await applyTransitionalPromotion(first, flags(), reprobe);

    expect(reprobe).not.toHaveBeenCalled();
    expect(result.classification).toBe('TARGET_BUNDLE_CONFIRMED');
  });
});
