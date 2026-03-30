/**
 * Web Vitals collection and analysis for mobile Safari performance auditing.
 *
 * Provides:
 * - PerformanceObserver injection scripts for LCP, CLS, FCP, INP
 * - Navigation Timing API extraction for TTFB
 * - Resource breakdown aggregation
 * - Long task detection
 * - Percentile calculation (p50/p95) across multiple runs
 * - Mobile-specific thresholds and recommendation engine
 */

// ── Types ──

export interface WebVitals {
  /** Largest Contentful Paint (ms) */
  lcp: number | null;
  /** Cumulative Layout Shift (unitless) */
  cls: number | null;
  /** Interaction to Next Paint (ms) */
  inp: number | null;
  /** First Contentful Paint (ms) */
  fcp: number | null;
  /** Time to First Byte (ms) */
  ttfb: number | null;
}

export interface ResourceEntry {
  name: string;
  type: string;
  duration: number;
  transferSize: number;
}

export interface ResourceBreakdown {
  scripts: number;
  styles: number;
  images: number;
  fonts: number;
  other: number;
}

export interface LongTask {
  duration: number;
  startTime: number;
}

export interface SingleRunResult {
  webVitals: WebVitals;
  resources: ResourceEntry[];
  resourceBreakdown: ResourceBreakdown;
  longTasks: LongTask[];
  totalTransferSize: number;
  domNodeCount: number;
}

export interface PercentileVitals {
  lcp: { p50: number | null; p95: number | null };
  cls: { p50: number | null; p95: number | null };
  inp: { p50: number | null; p95: number | null };
  fcp: { p50: number | null; p95: number | null };
  ttfb: { p50: number | null; p95: number | null };
}

export interface PerformanceAuditResult {
  webVitals: PercentileVitals;
  resourceBreakdown: ResourceBreakdown;
  longTasks: LongTask[];
  totalTransferSize: number;
  domNodeCount: number;
  recommendations: string[];
  runs: number;
}

// ── Mobile Thresholds ──

export const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
  totalTransferBytes: 1_000_000,
  longTaskMs: 50,
  uncompressedResourceBytes: 100_000,
  domNodeCount: 1500,
} as const;

// ── Percentile Calculation ──

/**
 * Calculate percentile value from a sorted array of numbers.
 * Uses linear interpolation between nearest ranks.
 */
export function percentile(values: number[], p: number): number | null {
  const filtered = values.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (filtered.length === 0) return null;

  const sorted = [...filtered].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

/**
 * Aggregate multiple runs into p50/p95 percentile vitals.
 */
export function aggregateVitals(runs: WebVitals[]): PercentileVitals {
  const extract = (key: keyof WebVitals): number[] =>
    runs.map(r => r[key]).filter((v): v is number => v !== null);

  return {
    lcp: { p50: percentile(extract('lcp'), 50), p95: percentile(extract('lcp'), 95) },
    cls: { p50: percentile(extract('cls'), 50), p95: percentile(extract('cls'), 95) },
    inp: { p50: percentile(extract('inp'), 50), p95: percentile(extract('inp'), 95) },
    fcp: { p50: percentile(extract('fcp'), 50), p95: percentile(extract('fcp'), 95) },
    ttfb: { p50: percentile(extract('ttfb'), 50), p95: percentile(extract('ttfb'), 95) },
  };
}

// ── Resource Breakdown ──

/**
 * Categorize resources by initiator type and sum transfer sizes.
 */
export function buildResourceBreakdown(resources: ResourceEntry[]): ResourceBreakdown {
  const breakdown: ResourceBreakdown = { scripts: 0, styles: 0, images: 0, fonts: 0, other: 0 };
  for (const r of resources) {
    const size = r.transferSize || 0;
    switch (r.type) {
      case 'script':
        breakdown.scripts += size;
        break;
      case 'link':
      case 'css':
        breakdown.styles += size;
        break;
      case 'img':
      case 'image':
        breakdown.images += size;
        break;
      case 'font':
        breakdown.fonts += size;
        break;
      default:
        breakdown.other += size;
        break;
    }
  }
  return breakdown;
}

// ── Recommendation Engine ──

/**
 * Generate mobile-specific performance recommendations based on audit results.
 */
export function generateRecommendations(result: {
  webVitals: PercentileVitals;
  resourceBreakdown: ResourceBreakdown;
  longTasks: LongTask[];
  totalTransferSize: number;
  domNodeCount: number;
  resources?: ResourceEntry[];
}): string[] {
  const recs: string[] = [];
  const v = result.webVitals;

  // Web Vitals checks (using p95 for worst-case mobile performance)
  if (v.lcp.p95 !== null && v.lcp.p95 > THRESHOLDS.lcp.good) {
    recs.push(
      v.lcp.p95 > THRESHOLDS.lcp.poor
        ? `LCP is poor (${Math.round(v.lcp.p95)}ms p95). Optimize largest element loading — preload hero images, inline critical CSS.`
        : `LCP needs improvement (${Math.round(v.lcp.p95)}ms p95). Consider preloading key resources.`,
    );
  }

  if (v.cls.p95 !== null && v.cls.p95 > THRESHOLDS.cls.good) {
    recs.push(
      v.cls.p95 > THRESHOLDS.cls.poor
        ? `CLS is poor (${v.cls.p95.toFixed(3)} p95). Set explicit dimensions on images/ads and avoid injecting content above the fold.`
        : `CLS needs improvement (${v.cls.p95.toFixed(3)} p95). Ensure images have width/height attributes.`,
    );
  }

  if (v.inp.p95 !== null && v.inp.p95 > THRESHOLDS.inp.good) {
    recs.push(
      v.inp.p95 > THRESHOLDS.inp.poor
        ? `INP is poor (${Math.round(v.inp.p95)}ms p95). Break up long event handlers and reduce main thread work.`
        : `INP needs improvement (${Math.round(v.inp.p95)}ms p95). Consider deferring non-critical JavaScript.`,
    );
  }

  if (v.fcp.p95 !== null && v.fcp.p95 > THRESHOLDS.fcp.good) {
    recs.push(
      v.fcp.p95 > THRESHOLDS.fcp.poor
        ? `FCP is poor (${Math.round(v.fcp.p95)}ms p95). Reduce render-blocking resources and inline critical CSS.`
        : `FCP needs improvement (${Math.round(v.fcp.p95)}ms p95). Minimize render-blocking scripts.`,
    );
  }

  if (v.ttfb.p95 !== null && v.ttfb.p95 > THRESHOLDS.ttfb.good) {
    recs.push(
      v.ttfb.p95 > THRESHOLDS.ttfb.poor
        ? `TTFB is poor (${Math.round(v.ttfb.p95)}ms p95). Optimize server response time — consider caching, CDN, or server-side performance.`
        : `TTFB needs improvement (${Math.round(v.ttfb.p95)}ms p95). Review server processing time.`,
    );
  }

  // Transfer size check
  if (result.totalTransferSize > THRESHOLDS.totalTransferBytes) {
    const mb = (result.totalTransferSize / 1_000_000).toFixed(1);
    recs.push(`Total transfer size is ${mb}MB — exceeds 1MB mobile budget. Compress images, tree-shake JavaScript, and enable gzip/brotli.`);
  }

  // Long tasks check
  const longTaskCount = result.longTasks.filter(t => t.duration > THRESHOLDS.longTaskMs).length;
  if (longTaskCount > 0) {
    const maxDuration = Math.max(...result.longTasks.map(t => t.duration));
    recs.push(`${longTaskCount} long task(s) detected (max ${Math.round(maxDuration)}ms). Break up JavaScript execution to avoid blocking the main thread.`);
  }

  // DOM node count
  if (result.domNodeCount > THRESHOLDS.domNodeCount) {
    recs.push(`DOM has ${result.domNodeCount} nodes (>${THRESHOLDS.domNodeCount}). Reduce DOM complexity for better rendering performance on mobile.`);
  }

  // Uncompressed resources
  if (result.resources) {
    const uncompressed = result.resources.filter(r => r.transferSize > THRESHOLDS.uncompressedResourceBytes);
    if (uncompressed.length > 0) {
      recs.push(`${uncompressed.length} resource(s) exceed 100KB uncompressed. Enable compression for these assets.`);
    }
  }

  return recs;
}

// ── JavaScript Injection Scripts ──

/**
 * JavaScript to inject into the page to set up PerformanceObservers.
 * Must be injected BEFORE navigation for accurate LCP/CLS/INP.
 */
export const OBSERVER_SETUP_SCRIPT = `
(function() {
  window.__opensafari_perf = { lcp: null, cls: 0, inp: null, fcp: null, longTasks: [] };

  // LCP
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      if (entries.length > 0) {
        window.__opensafari_perf.lcp = entries[entries.length - 1].startTime;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch(e) {}

  // CLS
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) {
          window.__opensafari_perf.cls += entries[i].value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch(e) {}

  // FCP
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'first-contentful-paint') {
          window.__opensafari_perf.fcp = entries[i].startTime;
        }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch(e) {}

  // Long Tasks
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        window.__opensafari_perf.longTasks.push({
          duration: entries[i].duration,
          startTime: entries[i].startTime
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch(e) {}

  // INP (approximation via event timing)
  try {
    window.__opensafari_perf.inp = null;
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var duration = entries[i].duration;
        if (window.__opensafari_perf.inp === null || duration > window.__opensafari_perf.inp) {
          window.__opensafari_perf.inp = duration;
        }
      }
    }).observe({ type: 'event', buffered: true });
  } catch(e) {}
})()
`;

/**
 * JavaScript to collect all accumulated performance data after page load + wait.
 */
export const COLLECT_METRICS_SCRIPT = `
(function() {
  var perf = window.__opensafari_perf || {};
  var nav = performance.getEntriesByType('navigation')[0] || {};

  // TTFB from Navigation Timing
  var ttfb = nav.responseStart ? nav.responseStart - nav.requestStart : null;

  // Fallback FCP from paint entries if observer missed it
  if (!perf.fcp) {
    var paints = performance.getEntriesByType('paint');
    for (var i = 0; i < paints.length; i++) {
      if (paints[i].name === 'first-contentful-paint') {
        perf.fcp = paints[i].startTime;
      }
    }
  }

  // Resource entries
  var resources = performance.getEntriesByType('resource').map(function(e) {
    return {
      name: e.name,
      type: e.initiatorType,
      duration: e.duration,
      transferSize: e.transferSize || 0
    };
  });

  // DOM node count
  var domNodeCount = document.getElementsByTagName('*').length;

  return {
    webVitals: {
      lcp: perf.lcp || null,
      cls: perf.cls || null,
      inp: perf.inp || null,
      fcp: perf.fcp || null,
      ttfb: ttfb
    },
    resources: resources,
    longTasks: perf.longTasks || [],
    domNodeCount: domNodeCount
  };
})()
`;
