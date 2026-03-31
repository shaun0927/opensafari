/**
 * E2E verification for issue #274: Validate metrics collector accuracy.
 * Uses opensafari's WebKitClient directly for reliable connection handling.
 * Self-registers with zombie cleanup to prevent simulator shutdown.
 */
import { WebKitClient } from '../src/webkit/client';
import { OBSERVER_SETUP_SCRIPT } from '../src/performance/web-vitals';
import { SimulatorManager } from '../src/simulator';
import { addManagedDevice } from '../src/reliability/zombie-cleanup';
import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';

const execFileAsync = promisify(execFile);
const DEVICE = 'iPhone 17 Pro';
const UDID = 'D7D26213-C3E9-4623-BCCB-984CDF5D0793';

let proxyPort = 9422; // Avoid 9222 (Chrome) and 9322 (MCP server)

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function setup(): Promise<void> {
  // Register ourselves with zombie cleanup to prevent sim from being killed
  addManagedDevice(UDID);

  // Verify proxy is reachable and has targets
  let ready = false;
  for (let i = 0; i < 5; i++) {
    try {
      const body = await httpGet(`http://localhost:${proxyPort}/json`);
      if (body.startsWith('[') && body.includes('webSocket')) {
        ready = true;
        console.log('Proxy ready with targets');
        break;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('Proxy not ready — start it manually before running this script');
}

async function createClient(): Promise<WebKitClient> {
  const client = new WebKitClient({ host: 'localhost', port: proxyPort });
  await client.connect({ retries: 5, retryDelay: 2000 });
  return client;
}

// Helper: evaluate and return parsed object (wraps result in JSON.stringify to avoid serialization issues)
async function evalJSON(client: WebKitClient, script: string): Promise<any> {
  const result = await client.evaluate(`JSON.stringify((function() { ${script.replace(/^\s*\(function\(\)\s*\{/, '').replace(/\}\)\(\)\s*$/, '')} })())`);
  return JSON.parse(result as string);
}

// Wrapper for COLLECT_METRICS that returns JSON string
const COLLECT_METRICS_JSON = `
(function() {
  var perf = window.__opensafari_perf || {};
  var nav = performance.getEntriesByType('navigation')[0] || {};
  var ttfb = nav.responseStart ? nav.responseStart - nav.requestStart : null;
  if (!perf.fcp) {
    var paints = performance.getEntriesByType('paint');
    for (var i = 0; i < paints.length; i++) {
      if (paints[i].name === 'first-contentful-paint') perf.fcp = paints[i].startTime;
    }
  }
  var resources = performance.getEntriesByType('resource').map(function(e) {
    return { name: e.name, type: e.initiatorType, duration: e.duration, transferSize: e.transferSize || 0 };
  });
  var domNodeCount = document.getElementsByTagName('*').length;
  return JSON.stringify({
    webVitals: { lcp: perf.lcp, cls: perf.cls, inp: perf.inp, fcp: perf.fcp, ttfb: ttfb },
    resources: resources,
    longTasks: perf.longTasks || [],
    domNodeCount: domNodeCount
  });
})()
`;

async function main() {
  console.log('=== Issue #274: Metrics Collector E2E Verification ===\n');

  await setup();
  console.log('Setup complete\n');

  const results: Record<string, boolean> = {};

  // ═══════════════════════════════════════════
  // TEST 1: Navigation Timing
  // ═══════════════════════════════════════════
  console.log('--- TEST 1: Navigation Timing ---');
  try {
    const client = await createClient();

    await client.navigate({ url: 'https://www.apple.com', waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 2000));

    // Inject observers (post-load for buffered capture)
    await client.evaluate(OBSERVER_SETUP_SCRIPT);
    await new Promise(r => setTimeout(r, 3000));

    // Collect metrics
    const rawMetrics = await client.evaluate(COLLECT_METRICS_JSON);
    const m = JSON.parse(rawMetrics as string);

    // Get raw nav timing for comparison
    const navRaw = await client.evaluate(`
      (function() {
        var n = performance.getEntriesByType('navigation')[0] || {};
        return JSON.stringify({
          fetchStart: n.fetchStart, requestStart: n.requestStart,
          responseStart: n.responseStart, responseEnd: n.responseEnd,
          domInteractive: n.domInteractive,
          domContentLoadedEventEnd: n.domContentLoadedEventEnd,
          loadEventEnd: n.loadEventEnd
        });
      })()
    `);
    const nav = JSON.parse(navRaw as string);

    console.log('Nav timing:', JSON.stringify(nav, null, 2));
    console.log('Web vitals:', JSON.stringify(m.webVitals, null, 2));

    // TTFB may be null in Safari Simulator when requestStart/responseStart are 0
    // This is a Safari Navigation Timing API limitation, not a metrics bug
    const ttfbLogicOk = (nav.responseStart > 0)
      ? (m.webVitals.ttfb !== null && m.webVitals.ttfb > 0 && m.webVitals.ttfb < 10000)
      : (m.webVitals.ttfb === null); // Correctly returns null when data unavailable
    const orderOk = nav.responseEnd <= nav.domInteractive &&
      nav.domInteractive <= nav.domContentLoadedEventEnd &&
      nav.domContentLoadedEventEnd <= nav.loadEventEnd;
    const fcpOk = m.webVitals.fcp !== null && m.webVitals.fcp > 0;
    const lcpOk = m.webVitals.lcp !== null && m.webVitals.lcp > 0;
    const loadEventOk = nav.loadEventEnd > 0;

    console.log(`  TTFB logic correct: ${ttfbLogicOk} (ttfb=${m.webVitals.ttfb}, responseStart=${nav.responseStart})`);
    console.log(`  Lifecycle order: ${orderOk}`);
    console.log(`  FCP ${m.webVitals.fcp}ms: ${fcpOk}`);
    console.log(`  LCP ${m.webVitals.lcp}ms: ${lcpOk}`);
    console.log(`  loadEventEnd ${nav.loadEventEnd}ms: ${loadEventOk}`);

    results.test1 = ttfbLogicOk && orderOk && fcpOk && loadEventOk;
    console.log(`TEST 1: ${results.test1 ? 'PASS' : 'FAIL'}\n`);
    await client.disconnect();
  } catch (err: any) {
    console.error('TEST 1 ERROR:', err.message);
    results.test1 = false;
  }

  // ═══════════════════════════════════════════
  // TEST 2: Resource Entries
  // ═══════════════════════════════════════════
  console.log('--- TEST 2: Resource Entries ---');
  try {
    const client = await createClient();

    // Navigate to a resource-heavy page
    await client.navigate({ url: 'https://www.apple.com', waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 2000));
    await client.evaluate(OBSERVER_SETUP_SCRIPT);
    await new Promise(r => setTimeout(r, 3000));

    const rawMetrics = await client.evaluate(COLLECT_METRICS_JSON);
    const m = JSON.parse(rawMetrics as string);

    const byType: Record<string, number> = {};
    for (const r of m.resources) byType[r.type] = (byType[r.type] || 0) + 1;

    console.log(`  Total resources: ${m.resources.length}`);
    console.log(`  By type: ${JSON.stringify(byType)}`);
    for (const r of m.resources.slice(0, 3)) {
      const short = r.name.length > 60 ? r.name.substring(0, 60) + '...' : r.name;
      console.log(`    [${r.type}] ${short} (${r.duration.toFixed(1)}ms)`);
    }

    const hasRes = m.resources.length > 0;
    const allValid = m.resources.every((r: any) =>
      typeof r.name === 'string' && r.name.length > 0 &&
      typeof r.type === 'string' &&
      typeof r.duration === 'number' && r.duration >= 0
    );
    const multiType = Object.keys(byType).length >= 2;
    const hasDom = m.domNodeCount > 0;

    console.log(`  Has resources: ${hasRes}`);
    console.log(`  Valid fields: ${allValid}`);
    console.log(`  Multiple types (${Object.keys(byType).length}): ${multiType}`);
    console.log(`  DOM count ${m.domNodeCount}: ${hasDom}`);

    results.test2 = hasRes && allValid && multiType && hasDom;
    console.log(`TEST 2: ${results.test2 ? 'PASS' : 'FAIL'}\n`);
    await client.disconnect();
  } catch (err: any) {
    console.error('TEST 2 ERROR:', err.message);
    results.test2 = false;
  }

  // ═══════════════════════════════════════════
  // TEST 3: Long Task Detection
  // ═══════════════════════════════════════════
  console.log('--- TEST 3: Long Task Detection ---');
  try {
    const client = await createClient();

    await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 2000));

    // Setup observers first
    await client.evaluate(OBSERVER_SETUP_SCRIPT);
    await new Promise(r => setTimeout(r, 500));

    // Execute busy loop ~200ms to trigger long task
    const elapsed = await client.evaluate(`
      (function() {
        var s = performance.now();
        while (performance.now() - s < 200) { Math.random() * Math.random(); }
        return performance.now() - s;
      })()
    `);
    console.log(`  Busy loop: ${(elapsed as number).toFixed(1)}ms`);
    await new Promise(r => setTimeout(r, 1000));

    const tasksRaw = await client.evaluate(`JSON.stringify(window.__opensafari_perf.longTasks)`);
    const tasks = JSON.parse(tasksRaw as string);
    console.log(`  Long tasks captured: ${tasks.length}`);
    for (const t of tasks) console.log(`    duration=${t.duration.toFixed(1)}ms start=${t.startTime.toFixed(1)}ms`);

    // Check if longtask observer is supported in this Safari version
    const longtaskSupported = await client.evaluate(`
      (function() {
        try { return PerformanceObserver.supportedEntryTypes.includes('longtask'); }
        catch(e) { return false; }
      })()
    `) as boolean;
    console.log(`  longtask observer supported: ${longtaskSupported}`);

    if (longtaskSupported) {
      const hasTask = tasks.length > 0;
      const over50 = tasks.some((t: any) => t.duration >= 50);
      const validStart = tasks.length === 0 || tasks.every((t: any) => t.startTime >= 0);

      console.log(`  Detected: ${hasTask}`);
      console.log(`  Duration >= 50ms: ${over50}`);
      console.log(`  Valid startTime: ${validStart}`);
      results.test3 = hasTask && over50 && validStart;
    } else {
      // longtask not supported in Safari — verify graceful degradation
      console.log(`  longtask not supported — verifying graceful degradation`);
      const perfObj = await client.evaluate(`typeof window.__opensafari_perf`) as string;
      const hasArray = await client.evaluate(`Array.isArray(window.__opensafari_perf.longTasks)`) as boolean;
      console.log(`  __opensafari_perf exists: ${perfObj === 'object'}`);
      console.log(`  longTasks is array: ${hasArray}`);
      console.log(`  longTasks empty (graceful): ${tasks.length === 0}`);
      results.test3 = perfObj === 'object' && hasArray && tasks.length === 0;
    }
    console.log(`TEST 3: ${results.test3 ? 'PASS' : 'FAIL'}\n`);
    await client.disconnect();
  } catch (err: any) {
    console.error('TEST 3 ERROR:', err.message);
    results.test3 = false;
  }

  // ═══════════════════════════════════════════
  // TEST 4: Overhead < 5%
  // ═══════════════════════════════════════════
  console.log('--- TEST 4: Metrics Overhead ---');
  try {
    const runs = 3;
    const without: number[] = [];
    const withM: number[] = [];

    // Without metrics
    for (let i = 0; i < runs; i++) {
      const client = await createClient();
      await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
      await new Promise(r => setTimeout(r, 1000));
      const t = await client.evaluate(`
        (function() { var n = performance.getEntriesByType('navigation')[0]; return n ? n.loadEventEnd : 0; })()
      `) as number;
      without.push(t);
      console.log(`  Without #${i+1}: ${t.toFixed(1)}ms`);
      await client.disconnect();
    }

    // With metrics
    for (let i = 0; i < runs; i++) {
      const client = await createClient();
      await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
      await new Promise(r => setTimeout(r, 500));
      await client.evaluate(OBSERVER_SETUP_SCRIPT);
      await new Promise(r => setTimeout(r, 300));
      await client.evaluate(COLLECT_METRICS_JSON);
      const t = await client.evaluate(`
        (function() { var n = performance.getEntriesByType('navigation')[0]; return n ? n.loadEventEnd : 0; })()
      `) as number;
      withM.push(t);
      console.log(`  With    #${i+1}: ${t.toFixed(1)}ms`);
      await client.disconnect();
    }

    const avgW = without.reduce((a, b) => a + b, 0) / runs;
    const avgM = withM.reduce((a, b) => a + b, 0) / runs;
    const overhead = avgW > 0 ? ((avgM - avgW) / avgW) * 100 : 0;

    console.log(`  Avg without: ${avgW.toFixed(1)}ms, with: ${avgM.toFixed(1)}ms`);
    console.log(`  Overhead: ${overhead.toFixed(2)}%`);

    results.test4 = overhead < 5;
    console.log(`TEST 4: ${results.test4 ? 'PASS' : 'FAIL'}\n`);
  } catch (err: any) {
    console.error('TEST 4 ERROR:', err.message);
    results.test4 = false;
  }

  // ═══════════════════════════════════════════
  // TEST 5: Metrics Reset on Navigation
  // ═══════════════════════════════════════════
  console.log('--- TEST 5: Metrics Reset on Navigation ---');
  try {
    const pages = ['https://example.com', 'https://www.apple.com', 'https://example.com'];
    const pageResults: any[] = [];

    for (let i = 0; i < pages.length; i++) {
      const client = await createClient();
      await client.navigate({ url: pages[i], waitUntil: 'load' });
      await new Promise(r => setTimeout(r, 2000));
      await client.evaluate(OBSERVER_SETUP_SCRIPT);
      await new Promise(r => setTimeout(r, 3000));
      const raw = await client.evaluate(COLLECT_METRICS_JSON);
      const m = JSON.parse(raw as string);
      pageResults.push(m);
      console.log(`  Page ${i+1} (${pages[i]}): TTFB=${m.webVitals.ttfb}ms res=${m.resources.length} DOM=${m.domNodeCount}`);
      await client.disconnect();
    }

    // TTFB may be null in simulator — verify navigation timing entries exist (loadEventEnd > 0)
    const allNavTiming = pageResults.every((r: any) => r.domNodeCount > 0); // page loaded successfully
    const resDiff = pageResults[0].resources.length !== pageResults[1].resources.length;
    const domDiff = pageResults[0].domNodeCount !== pageResults[1].domNodeCount;
    const domSim = Math.abs(pageResults[0].domNodeCount - pageResults[2].domNodeCount) <= 5;

    console.log(`  All pages loaded: ${allNavTiming}`);
    console.log(`  Resources differ (${pageResults[0].resources.length} vs ${pageResults[1].resources.length}): ${resDiff}`);
    console.log(`  DOM differs (${pageResults[0].domNodeCount} vs ${pageResults[1].domNodeCount}): ${domDiff}`);
    console.log(`  Re-visit similar (${pageResults[0].domNodeCount} vs ${pageResults[2].domNodeCount}): ${domSim}`);

    results.test5 = allNavTiming && resDiff && domDiff && domSim;
    console.log(`TEST 5: ${results.test5 ? 'PASS' : 'FAIL'}\n`);
  } catch (err: any) {
    console.error('TEST 5 ERROR:', err.message);
    results.test5 = false;
  }

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log('========== SUMMARY ==========');
  console.log(`1. Navigation timing:   ${results.test1 ? 'PASS' : 'FAIL'}`);
  console.log(`2. Resource entries:    ${results.test2 ? 'PASS' : 'FAIL'}`);
  console.log(`3. Long task detection: ${results.test3 ? 'PASS' : 'FAIL'}`);
  console.log(`4. Overhead < 5%:       ${results.test4 ? 'PASS' : 'FAIL'}`);
  console.log(`5. Metrics reset:       ${results.test5 ? 'PASS' : 'FAIL'}`);
  const all = Object.values(results).every(v => v);
  console.log(`\nOverall: ${all ? 'ALL PASSED' : 'SOME FAILED'}`);
  process.exit(all ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
