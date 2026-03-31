/**
 * E2E verification for issue #274: Validate metrics collector accuracy.
 * Connects directly to Safari via ios_webkit_debug_proxy (no Target multiplexing needed).
 */
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 9322;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function connect() {
  const json = await httpGet(`http://localhost:${PROXY_PORT}/json`);
  const targets = JSON.parse(json);
  if (!targets.length) throw new Error('No Safari targets');
  console.log(`Target: ${targets[0].title} (${targets[0].url})`);

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 10000);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.result?.value !== undefined) return res.result.value;
    if (res.result?.type === 'undefined') return undefined;
    if (res.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(res.exceptionDetails));
    throw new Error('Evaluate failed: ' + JSON.stringify(res));
  }

  async function navigateTo(url) {
    // Navigate via JS (most reliable across WebKit versions)
    await evaluate(`window.location.href = ${JSON.stringify(url)}`);
    // Wait for page load
    await new Promise(r => setTimeout(r, 5000));
    // Reconnect since page changed - get new WS target
    return null; // Signal caller to reconnect
  }

  await send('Runtime.enable');
  await send('Page.enable');

  return { ws, send, evaluate, navigateTo, close: () => ws.close() };
}

// Reconnect after navigation (page change creates new target)
async function connectFresh() {
  // Wait for proxy to update targets
  await new Promise(r => setTimeout(r, 2000));
  return connect();
}

// ── Scripts from web-vitals.ts ──
const OBSERVER_SETUP = `
(function() {
  window.__opensafari_perf = { lcp: null, cls: 0, inp: null, fcp: null, longTasks: [] };
  try { new PerformanceObserver(function(list) {
    var entries = list.getEntries();
    if (entries.length > 0) window.__opensafari_perf.lcp = entries[entries.length - 1].startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch(e) {}
  try { new PerformanceObserver(function(list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].hadRecentInput) window.__opensafari_perf.cls += entries[i].value;
    }
  }).observe({ type: 'layout-shift', buffered: true }); } catch(e) {}
  try { new PerformanceObserver(function(list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === 'first-contentful-paint') window.__opensafari_perf.fcp = entries[i].startTime;
    }
  }).observe({ type: 'paint', buffered: true }); } catch(e) {}
  try { new PerformanceObserver(function(list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i++) {
      window.__opensafari_perf.longTasks.push({ duration: entries[i].duration, startTime: entries[i].startTime });
    }
  }).observe({ type: 'longtask', buffered: true }); } catch(e) {}
  return 'ok';
})()`;

const COLLECT_METRICS = `
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
})()`;

async function navigateAndConnect(url) {
  // Open URL in simulator, then reconnect
  const { execSync } = require('child_process');
  const udid = 'D7D26213-C3E9-4623-BCCB-984CDF5D0793';
  execSync(`xcrun simctl openurl ${udid} "${url}"`, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 6000));
  return connect();
}

async function main() {
  console.log('=== Issue #274: Metrics Collector E2E Verification ===\n');

  const results = {};

  // ════════════════════════════════════════
  // TEST 1: Navigation Timing
  // ════════════════════════════════════════
  console.log('--- TEST 1: Navigation Timing ---');
  try {
    let c = await navigateAndConnect('https://www.apple.com');
    await c.evaluate(OBSERVER_SETUP);
    await new Promise(r => setTimeout(r, 3000));

    const raw = await c.evaluate(COLLECT_METRICS);
    const m = JSON.parse(raw);

    const navRaw = await c.evaluate(`
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
    const nav = JSON.parse(navRaw);

    console.log('Nav timing:', JSON.stringify(nav, null, 2));
    console.log('Web vitals:', JSON.stringify(m.webVitals, null, 2));

    const ttfbOk = m.webVitals.ttfb !== null && m.webVitals.ttfb > 0 && m.webVitals.ttfb < 10000;
    const orderOk = nav.fetchStart <= nav.requestStart &&
      nav.requestStart <= nav.responseStart &&
      nav.responseStart <= nav.responseEnd &&
      nav.responseEnd <= nav.domInteractive &&
      nav.domInteractive <= nav.domContentLoadedEventEnd &&
      nav.domContentLoadedEventEnd <= nav.loadEventEnd;
    const fcpOk = m.webVitals.fcp !== null && m.webVitals.fcp > 0;
    const calcTtfb = nav.responseStart - nav.requestStart;
    const ttfbMatch = Math.abs((m.webVitals.ttfb || 0) - calcTtfb) < 1;

    console.log(`  TTFB ${m.webVitals.ttfb}ms valid: ${ttfbOk}`);
    console.log(`  Lifecycle order: ${orderOk}`);
    console.log(`  FCP ${m.webVitals.fcp}ms: ${fcpOk}`);
    console.log(`  TTFB matches raw (${calcTtfb.toFixed(1)}ms): ${ttfbMatch}`);

    results.test1 = ttfbOk && orderOk && fcpOk;
    console.log(`TEST 1: ${results.test1 ? 'PASS' : 'FAIL'}\n`);
    c.close();
  } catch (err) {
    console.error('TEST 1 ERROR:', err.message);
    results.test1 = false;
  }

  // ════════════════════════════════════════
  // TEST 2: Resource Entries
  // ════════════════════════════════════════
  console.log('--- TEST 2: Resource Entries ---');
  try {
    // apple.com from test1 should still be loaded - reconnect
    let c = await connect();
    await c.evaluate(OBSERVER_SETUP);
    await new Promise(r => setTimeout(r, 2000));

    const raw = await c.evaluate(COLLECT_METRICS);
    const m = JSON.parse(raw);

    const byType = {};
    for (const r of m.resources) byType[r.type] = (byType[r.type] || 0) + 1;

    console.log(`  Total resources: ${m.resources.length}`);
    console.log(`  By type: ${JSON.stringify(byType)}`);
    for (const r of m.resources.slice(0, 3)) {
      const short = r.name.length > 60 ? r.name.substring(0, 60) + '...' : r.name;
      console.log(`    [${r.type}] ${short} (${r.duration.toFixed(1)}ms)`);
    }

    const hasRes = m.resources.length > 0;
    const allValid = m.resources.every(r =>
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
    c.close();
  } catch (err) {
    console.error('TEST 2 ERROR:', err.message);
    results.test2 = false;
  }

  // ════════════════════════════════════════
  // TEST 3: Long Task Detection
  // ════════════════════════════════════════
  console.log('--- TEST 3: Long Task Detection ---');
  try {
    let c = await navigateAndConnect('https://example.com');
    await c.evaluate(OBSERVER_SETUP);
    await new Promise(r => setTimeout(r, 500));

    // Execute busy loop ~200ms
    const elapsed = await c.evaluate(`
      (function() {
        var s = performance.now();
        while (performance.now() - s < 200) { Math.random() * Math.random(); }
        return performance.now() - s;
      })()
    `);
    console.log(`  Busy loop: ${elapsed.toFixed(1)}ms`);
    await new Promise(r => setTimeout(r, 1000));

    const tasksRaw = await c.evaluate(`JSON.stringify(window.__opensafari_perf.longTasks)`);
    const tasks = JSON.parse(tasksRaw);
    console.log(`  Long tasks captured: ${tasks.length}`);
    for (const t of tasks) console.log(`    duration=${t.duration.toFixed(1)}ms start=${t.startTime.toFixed(1)}ms`);

    const hasTask = tasks.length > 0;
    const over50 = tasks.some(t => t.duration >= 50);
    const validStart = tasks.length === 0 || tasks.every(t => t.startTime >= 0);

    console.log(`  Detected: ${hasTask}`);
    console.log(`  Duration >= 50ms: ${over50}`);
    console.log(`  Valid startTime: ${validStart}`);

    results.test3 = hasTask && over50 && validStart;
    console.log(`TEST 3: ${results.test3 ? 'PASS' : 'FAIL'}\n`);
    c.close();
  } catch (err) {
    console.error('TEST 3 ERROR:', err.message);
    results.test3 = false;
  }

  // ════════════════════════════════════════
  // TEST 4: Overhead < 5%
  // ════════════════════════════════════════
  console.log('--- TEST 4: Metrics Overhead ---');
  try {
    const runs = 3;
    const without = [];
    const withM = [];

    for (let i = 0; i < runs; i++) {
      let c = await navigateAndConnect('https://example.com');
      const t = await c.evaluate(`
        (function() { var n = performance.getEntriesByType('navigation')[0]; return n ? n.loadEventEnd : 0; })()
      `);
      without.push(t);
      console.log(`  Without #${i+1}: ${t.toFixed(1)}ms`);
      c.close();
    }

    for (let i = 0; i < runs; i++) {
      let c = await navigateAndConnect('https://example.com');
      await c.evaluate(OBSERVER_SETUP);
      await new Promise(r => setTimeout(r, 300));
      await c.evaluate(COLLECT_METRICS);
      const t = await c.evaluate(`
        (function() { var n = performance.getEntriesByType('navigation')[0]; return n ? n.loadEventEnd : 0; })()
      `);
      withM.push(t);
      console.log(`  With    #${i+1}: ${t.toFixed(1)}ms`);
      c.close();
    }

    const avgW = without.reduce((a,b) => a+b, 0) / runs;
    const avgM = withM.reduce((a,b) => a+b, 0) / runs;
    const overhead = avgW > 0 ? ((avgM - avgW) / avgW) * 100 : 0;

    console.log(`  Avg without: ${avgW.toFixed(1)}ms, with: ${avgM.toFixed(1)}ms`);
    console.log(`  Overhead: ${overhead.toFixed(2)}%`);

    results.test4 = overhead < 5;
    console.log(`TEST 4: ${results.test4 ? 'PASS' : 'FAIL'}\n`);
  } catch (err) {
    console.error('TEST 4 ERROR:', err.message);
    results.test4 = false;
  }

  // ════════════════════════════════════════
  // TEST 5: Metrics Reset on Navigation
  // ════════════════════════════════════════
  console.log('--- TEST 5: Metrics Reset on Navigation ---');
  try {
    const pages = ['https://example.com', 'https://www.apple.com', 'https://example.com'];
    const pageResults = [];

    for (let i = 0; i < pages.length; i++) {
      let c = await navigateAndConnect(pages[i]);
      await c.evaluate(OBSERVER_SETUP);
      await new Promise(r => setTimeout(r, 3000));
      const raw = await c.evaluate(COLLECT_METRICS);
      const m = JSON.parse(raw);
      pageResults.push(m);
      console.log(`  Page ${i+1} (${pages[i]}): TTFB=${m.webVitals.ttfb}ms res=${m.resources.length} DOM=${m.domNodeCount}`);
      c.close();
    }

    const allTtfb = pageResults.every(r => r.webVitals.ttfb !== null && r.webVitals.ttfb > 0);
    const resDiff = pageResults[0].resources.length !== pageResults[1].resources.length;
    const domDiff = pageResults[0].domNodeCount !== pageResults[1].domNodeCount;
    const domSim = Math.abs(pageResults[0].domNodeCount - pageResults[2].domNodeCount) <= 5;

    console.log(`  All TTFB valid: ${allTtfb}`);
    console.log(`  Resources differ (${pageResults[0].resources.length} vs ${pageResults[1].resources.length}): ${resDiff}`);
    console.log(`  DOM differs (${pageResults[0].domNodeCount} vs ${pageResults[1].domNodeCount}): ${domDiff}`);
    console.log(`  Re-visit similar (${pageResults[0].domNodeCount} vs ${pageResults[2].domNodeCount}): ${domSim}`);

    results.test5 = allTtfb && resDiff && domDiff && domSim;
    console.log(`TEST 5: ${results.test5 ? 'PASS' : 'FAIL'}\n`);
  } catch (err) {
    console.error('TEST 5 ERROR:', err.message);
    results.test5 = false;
  }

  // ════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════
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

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
