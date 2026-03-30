import {
  percentile,
  aggregateVitals,
  buildResourceBreakdown,
  generateRecommendations,
  THRESHOLDS,
  WebVitals,
  ResourceEntry,
  PercentileVitals,
} from '../../src/performance/web-vitals';

// ── percentile() ──

describe('percentile()', () => {
  test('returns null for empty array', () => {
    expect(percentile([], 50)).toBeNull();
  });

  test('returns the single value for one-element array', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  test('calculates p50 (median) for odd-length array', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  test('calculates p50 (median) for even-length array with interpolation', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  test('calculates p95 correctly', () => {
    // 20 values: 1..20
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = percentile(values, 95);
    // p95 index = 0.95 * 19 = 18.05 → interpolate between 19 and 20
    expect(result).toBeCloseTo(19.05, 2);
  });

  test('handles unsorted input', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  });

  test('filters NaN values', () => {
    expect(percentile([1, NaN, 3, NaN, 5], 50)).toBe(3);
  });

  test('returns null when all values are NaN', () => {
    expect(percentile([NaN, NaN], 50)).toBeNull();
  });

  test('p0 returns minimum', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  test('p100 returns maximum', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  test('handles duplicate values', () => {
    expect(percentile([5, 5, 5, 5], 50)).toBe(5);
  });
});

// ── aggregateVitals() ──

describe('aggregateVitals()', () => {
  test('aggregates multiple runs into p50/p95', () => {
    const runs: WebVitals[] = [
      { lcp: 2000, cls: 0.05, inp: 100, fcp: 1000, ttfb: 400 },
      { lcp: 2500, cls: 0.08, inp: 150, fcp: 1200, ttfb: 500 },
      { lcp: 3000, cls: 0.12, inp: 200, fcp: 1500, ttfb: 600 },
    ];
    const result = aggregateVitals(runs);

    expect(result.lcp.p50).toBe(2500);
    expect(result.cls.p50).toBe(0.08);
    expect(result.fcp.p50).toBe(1200);
    expect(result.ttfb.p50).toBe(500);
  });

  test('handles null values in some runs', () => {
    const runs: WebVitals[] = [
      { lcp: 2000, cls: null, inp: null, fcp: 1000, ttfb: 400 },
      { lcp: 3000, cls: 0.1, inp: null, fcp: 1500, ttfb: 600 },
    ];
    const result = aggregateVitals(runs);

    expect(result.lcp.p50).toBe(2500);
    expect(result.cls.p50).toBe(0.1); // only one non-null value
    expect(result.inp.p50).toBeNull(); // all null
    expect(result.inp.p95).toBeNull();
  });

  test('handles single run', () => {
    const runs: WebVitals[] = [
      { lcp: 2000, cls: 0.05, inp: 100, fcp: 1000, ttfb: 400 },
    ];
    const result = aggregateVitals(runs);

    expect(result.lcp.p50).toBe(2000);
    expect(result.lcp.p95).toBe(2000);
  });

  test('handles empty runs array', () => {
    const result = aggregateVitals([]);

    expect(result.lcp.p50).toBeNull();
    expect(result.lcp.p95).toBeNull();
    expect(result.cls.p50).toBeNull();
  });
});

// ── buildResourceBreakdown() ──

describe('buildResourceBreakdown()', () => {
  test('categorizes resources by type', () => {
    const resources: ResourceEntry[] = [
      { name: 'app.js', type: 'script', duration: 100, transferSize: 50000 },
      { name: 'style.css', type: 'link', duration: 50, transferSize: 20000 },
      { name: 'hero.png', type: 'img', duration: 200, transferSize: 300000 },
      { name: 'font.woff2', type: 'font', duration: 80, transferSize: 40000 },
      { name: 'data.json', type: 'fetch', duration: 30, transferSize: 5000 },
    ];

    const breakdown = buildResourceBreakdown(resources);

    expect(breakdown.scripts).toBe(50000);
    expect(breakdown.styles).toBe(20000);
    expect(breakdown.images).toBe(300000);
    expect(breakdown.fonts).toBe(40000);
    expect(breakdown.other).toBe(5000);
  });

  test('handles css initiator type', () => {
    const resources: ResourceEntry[] = [
      { name: 'bg.png', type: 'css', duration: 10, transferSize: 10000 },
    ];
    expect(buildResourceBreakdown(resources).styles).toBe(10000);
  });

  test('handles image initiator type', () => {
    const resources: ResourceEntry[] = [
      { name: 'pic.webp', type: 'image', duration: 10, transferSize: 15000 },
    ];
    expect(buildResourceBreakdown(resources).images).toBe(15000);
  });

  test('returns zeroes for empty array', () => {
    const breakdown = buildResourceBreakdown([]);
    expect(breakdown).toEqual({ scripts: 0, styles: 0, images: 0, fonts: 0, other: 0 });
  });

  test('handles zero transferSize', () => {
    const resources: ResourceEntry[] = [
      { name: 'cached.js', type: 'script', duration: 5, transferSize: 0 },
    ];
    expect(buildResourceBreakdown(resources).scripts).toBe(0);
  });
});

// ── generateRecommendations() ──

describe('generateRecommendations()', () => {
  function makeResult(overrides: Partial<{
    vitals: Partial<PercentileVitals>;
    totalTransferSize: number;
    longTasks: { duration: number; startTime: number }[];
    domNodeCount: number;
    resources: ResourceEntry[];
  }> = {}) {
    const defaultVitals: PercentileVitals = {
      lcp: { p50: null, p95: null },
      cls: { p50: null, p95: null },
      inp: { p50: null, p95: null },
      fcp: { p50: null, p95: null },
      ttfb: { p50: null, p95: null },
    };
    return {
      webVitals: { ...defaultVitals, ...overrides.vitals },
      resourceBreakdown: { scripts: 0, styles: 0, images: 0, fonts: 0, other: 0 },
      longTasks: overrides.longTasks || [],
      totalTransferSize: overrides.totalTransferSize || 0,
      domNodeCount: overrides.domNodeCount || 100,
      resources: overrides.resources,
    };
  }

  test('returns empty array for good metrics', () => {
    const result = makeResult({
      vitals: {
        lcp: { p50: 1000, p95: 2000 },
        cls: { p50: 0.02, p95: 0.05 },
        fcp: { p50: 800, p95: 1500 },
        ttfb: { p50: 200, p95: 500 },
      },
      totalTransferSize: 500_000,
      domNodeCount: 500,
    });
    expect(generateRecommendations(result)).toEqual([]);
  });

  test('flags poor LCP', () => {
    const result = makeResult({
      vitals: { lcp: { p50: 3000, p95: 5000 } },
    });
    const recs = generateRecommendations(result);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatch(/LCP is poor/);
  });

  test('flags needs-improvement LCP', () => {
    const result = makeResult({
      vitals: { lcp: { p50: 2000, p95: 3000 } },
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/LCP needs improvement/);
  });

  test('flags poor CLS', () => {
    const result = makeResult({
      vitals: { cls: { p50: 0.15, p95: 0.3 } },
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/CLS is poor/);
  });

  test('flags poor INP', () => {
    const result = makeResult({
      vitals: { inp: { p50: 300, p95: 600 } },
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/INP is poor/);
  });

  test('flags poor TTFB', () => {
    const result = makeResult({
      vitals: { ttfb: { p50: 1000, p95: 2000 } },
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/TTFB is poor/);
  });

  test('flags large total transfer size', () => {
    const result = makeResult({ totalTransferSize: 2_500_000 });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/2\.5MB/);
  });

  test('flags long tasks', () => {
    const result = makeResult({
      longTasks: [
        { duration: 120, startTime: 500 },
        { duration: 80, startTime: 1000 },
      ],
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/2 long task/);
    expect(recs[0]).toMatch(/120ms/);
  });

  test('flags high DOM node count', () => {
    const result = makeResult({ domNodeCount: 2000 });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/2000 nodes/);
  });

  test('flags uncompressed resources', () => {
    const result = makeResult({
      resources: [
        { name: 'big.js', type: 'script', duration: 100, transferSize: 200_000 },
        { name: 'small.js', type: 'script', duration: 10, transferSize: 5_000 },
      ],
    });
    const recs = generateRecommendations(result);
    expect(recs[0]).toMatch(/1 resource.*exceed 100KB/);
  });

  test('accumulates multiple recommendations', () => {
    const result = makeResult({
      vitals: {
        lcp: { p50: 3000, p95: 5000 },
        cls: { p50: 0.15, p95: 0.3 },
      },
      totalTransferSize: 2_000_000,
      longTasks: [{ duration: 200, startTime: 100 }],
      domNodeCount: 2000,
    });
    const recs = generateRecommendations(result);
    expect(recs.length).toBeGreaterThanOrEqual(4);
  });

  test('skips null vitals', () => {
    const result = makeResult(); // all null vitals
    expect(generateRecommendations(result)).toEqual([]);
  });
});

// ── THRESHOLDS ──

describe('THRESHOLDS', () => {
  test('has expected mobile thresholds', () => {
    expect(THRESHOLDS.lcp.good).toBe(2500);
    expect(THRESHOLDS.cls.good).toBe(0.1);
    expect(THRESHOLDS.inp.good).toBe(200);
    expect(THRESHOLDS.fcp.good).toBe(1800);
    expect(THRESHOLDS.ttfb.good).toBe(800);
    expect(THRESHOLDS.totalTransferBytes).toBe(1_000_000);
    expect(THRESHOLDS.longTaskMs).toBe(50);
  });
});
