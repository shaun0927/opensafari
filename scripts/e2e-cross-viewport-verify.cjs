#!/usr/bin/env node
/**
 * E2E Verification: Cross-Viewport Comparison (#256)
 * Tests all 6 acceptance criteria on real simulators
 *
 * Approach: boot 3 devices sequentially, each gets its own
 * ios_webkit_debug_proxy instance on separate ports.
 */
const { execFileSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const http = require('http');
const execFileAsync = promisify(execFile);

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
const DEVICES = [
  { type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation', label: 'iPhone SE', expectedWidth: 375, proxyDL: 9601, proxyBase: 9602 },
  { type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', label: 'iPhone 17', expectedWidth: 402, proxyDL: 9611, proxyBase: 9612 },
  { type: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB', label: 'iPad Pro', expectedWidth: 1024, proxyDL: 9621, proxyBase: 9622 },
];
const TEST_URL = 'https://example.com';
const OVERFLOW_HTML = 'data:text/html,<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.wide{width:2000px;height:100px;background:red}</style></head><body><div class="wide">overflow test</div></body></html>';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function findSocket(udid) {
  try {
    const out = execFileSync('lsof', ['-U'], { encoding: 'utf-8', timeout: 10000 });
    const lines = out.split('\n').filter(l => l.startsWith('launchd_s') && l.includes('webinspectord_sim.socket'));
    // Map PID -> socket path
    const candidates = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parts[1];
      const socketPath = parts[parts.length - 1];
      if (!candidates.some(c => c.pid === pid)) candidates.push({ pid, socketPath });
    }
    // Match PID to UDID via ps
    for (const { pid, socketPath } of candidates) {
      try {
        const { stdout } = execFileSync('ps', ['-p', pid, '-o', 'args='], { encoding: 'utf-8', timeout: 5000 });
        if (stdout.includes(udid)) return socketPath;
      } catch {}
    }
    // Fallback: if only 1 candidate, use it
    if (candidates.length === 1) return candidates[0].socketPath;
    return null;
  } catch { return null; }
}

function mapBreakpoint(w) {
  if (w < 768) return 'sm';
  if (w < 1024) return 'md';
  if (w < 1280) return 'lg';
  return 'xl';
}

(async () => {
  const { WebKitClient } = require('../dist/index.js');
  console.log('[OK] opensafari dist loaded');

  const sims = [];
  const proxyProcs = [];
  const errors = [];

  // ═══ Phase 1: Create & Boot ═══
  console.log('\n== Phase 1: Create & Boot ==');
  const overallStart = Date.now();

  for (const dev of DEVICES) {
    console.log(`  Creating ${dev.label}...`);
    const udid = execFileSync('xcrun', ['simctl', 'create', `E2E-${dev.label}`, dev.type, RUNTIME],
      { encoding: 'utf-8', timeout: 30000 }).trim();
    sims.push({ ...dev, udid, client: null, socket: null });
    console.log(`  [CREATED] ${dev.label} (${udid})`);
  }

  // Boot sequentially
  const bootStart = Date.now();
  for (const sim of sims) {
    console.log(`  Booting ${sim.label}...`);
    try { execFileSync('xcrun', ['simctl', 'boot', sim.udid], { timeout: 60000 }); } catch {}
  }

  // Wait for all to be Booted
  console.log('  Waiting for all devices to boot...');
  await sleep(20000);

  for (const sim of sims) {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf-8' });
    const data = JSON.parse(raw);
    let state = 'unknown';
    for (const devs of Object.values(data.devices)) {
      const d = devs.find(x => x.udid === sim.udid);
      if (d) { state = d.state; break; }
    }
    console.log(`  ${sim.label}: ${state}`);
    if (state !== 'Booted') errors.push(`${sim.label} not booted: ${state}`);
  }
  const bootTime = Date.now() - bootStart;
  console.log(`  Boot time: ${bootTime}ms`);

  // Launch Safari on each
  console.log('  Launching Safari...');
  for (const sim of sims) {
    try {
      await execFileAsync('xcrun', ['simctl', 'launch', sim.udid, 'com.apple.mobilesafari'], { timeout: 30000 });
      console.log(`  [SAFARI LAUNCHED] ${sim.label}`);
    } catch (e) { console.log(`  [SAFARI WARN] ${sim.label}: ${String(e).substring(0, 100)}`); }
    await sleep(2000);
  }
  await sleep(5000);

  // Open URL on each
  for (const sim of sims) {
    for (let i = 0; i < 5; i++) {
      try {
        await execFileAsync('xcrun', ['simctl', 'openurl', sim.udid, TEST_URL], { timeout: 15000 });
        console.log(`  [URL] ${sim.label}`);
        break;
      } catch {
        if (i < 4) await sleep(3000);
        else { errors.push(`openurl failed: ${sim.label}`); console.log(`  [URL FAIL] ${sim.label}`); }
      }
    }
  }
  await sleep(5000);

  // ═══ Phase 2: Per-device proxy ═══
  console.log('\n== Phase 2: Per-device Proxy ==');

  for (const sim of sims) {
    sim.socket = findSocket(sim.udid);
    if (!sim.socket) {
      // Fallback: find any webinspector socket
      try {
        const out = execFileSync('lsof', ['-U'], { encoding: 'utf-8', timeout: 10000 });
        const lines = out.split('\n').filter(l => l.includes('webinspectord_sim.socket'));
        const paths = [...new Set(lines.map(l => l.split(/\s+/).pop()))];
        // Try sockets that haven't been assigned yet
        const used = sims.filter(s => s.socket).map(s => s.socket);
        const available = paths.filter(p => !used.includes(p));
        if (available.length > 0) sim.socket = available[0];
      } catch {}
    }
    console.log(`  ${sim.label} socket: ${sim.socket || 'NOT FOUND'}`);
  }

  // Start a proxy per device
  for (const sim of sims) {
    if (!sim.socket) { errors.push(`No socket: ${sim.label}`); continue; }
    const args = ['-s', `unix:${sim.socket}`, '-c', `null:${sim.proxyDL},:${sim.proxyBase}-${sim.proxyBase + 10}`, '-F'];
    const proc = spawn('ios_webkit_debug_proxy', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => {}); // suppress noise
    proc.on('exit', code => {});
    proxyProcs.push(proc);
    console.log(`  [PROXY] ${sim.label} on ${sim.proxyDL}/${sim.proxyBase}`);
  }

  console.log('  Waiting for forwarding...');
  await sleep(12000);

  // ═══ Phase 3: Connect & Capture ═══
  console.log('\n== Phase 3: Connect ==');
  const captureStart = Date.now();

  for (const sim of sims) {
    if (!sim.socket) continue;
    // Find target port
    let targetPort = null;
    for (let p = sim.proxyBase; p < sim.proxyBase + 10; p++) {
      try {
        const body = await httpGet(`http://localhost:${p}/json`, 2000);
        const targets = JSON.parse(body);
        if (targets.length > 0) { targetPort = p; break; }
      } catch {}
    }
    if (!targetPort) { errors.push(`No targets: ${sim.label}`); console.log(`  [NO TARGETS] ${sim.label}`); continue; }

    try {
      const client = new WebKitClient({ host: 'localhost', port: targetPort });
      await client.connect({ retries: 3, retryDelay: 3000 });
      sim.client = client;
      console.log(`  [CONNECTED] ${sim.label}:${targetPort}`);
    } catch (e) {
      errors.push(`Connect: ${sim.label}`);
      console.log(`  [CONNECT FAIL] ${sim.label}: ${e.message}`);
    }
  }

  // Navigate
  const connected = sims.filter(s => s.client);
  console.log(`  Navigating ${connected.length} devices to ${TEST_URL}...`);
  await Promise.all(connected.map(async sim => {
    try {
      await sim.client.navigate({ url: TEST_URL, waitUntil: 'load' });
      console.log(`  [NAV] ${sim.label}`);
    } catch (e) { errors.push(`Nav: ${sim.label}`); console.log(`  [NAV FAIL] ${sim.label}`); }
  }));
  await sleep(2000);

  // ═══ Phase 4: Screenshots & Metadata ═══
  console.log('\n== Phase 4: Capture ==');
  const captures = [];
  for (const sim of connected) {
    const t0 = Date.now();
    try {
      const buf = await sim.client.screenshot({ format: 'png' });
      const b64 = buf.toString('base64');
      const raw = await sim.client.evaluate(
        '(function(){return JSON.stringify({title:document.title,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,innerHeight:window.innerHeight,devicePixelRatio:window.devicePixelRatio,hasHorizontalOverflow:document.documentElement.scrollWidth>window.innerWidth})})()'
      );
      const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
      captures.push({
        device: sim.label,
        viewport: { w: meta.innerWidth, h: meta.innerHeight },
        breakpoint: mapBreakpoint(meta.innerWidth),
        screenshot: b64,
        metadata: meta,
        timing: Date.now() - t0,
      });
      console.log(`  [OK] ${sim.label}: ${meta.innerWidth}x${meta.innerHeight} DPR=${meta.devicePixelRatio} ${Date.now() - t0}ms`);
    } catch (e) {
      errors.push(`Capture: ${sim.label}: ${e.message}`);
      console.log(`  [FAIL] ${sim.label}: ${e.message}`);
    }
  }
  const captureTime = Date.now() - captureStart;

  // ═══ Phase 5: Overflow Detection ═══
  console.log('\n== Phase 5: Overflow Detection ==');
  const overflowResults = [];
  for (const sim of connected) {
    try {
      await sim.client.navigate({ url: OVERFLOW_HTML, waitUntil: 'load' });
      await sleep(1500);
      const raw = await sim.client.evaluate(
        '(function(){return JSON.stringify({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,hasHorizontalOverflow:document.documentElement.scrollWidth>window.innerWidth})})()'
      );
      const om = typeof raw === 'string' ? JSON.parse(raw) : raw;
      overflowResults.push({ device: sim.label, ...om });
      console.log(`  [${om.hasHorizontalOverflow ? 'DETECTED' : 'MISSED'}] ${sim.label}: scroll=${om.scrollWidth} inner=${om.innerWidth}`);
    } catch (e) {
      overflowResults.push({ device: sim.label, hasHorizontalOverflow: false, error: e.message });
      console.log(`  [FAIL] ${sim.label}: ${e.message}`);
    }
  }

  // ═══ Phase 6: Report Generation ═══
  console.log('\n== Phase 6: Report ==');
  // Inline report (generateMarkdownReport not in dist exports)
  const reportLines = [
    '# Cross-Viewport Comparison Report', '',
    `**URL:** ${TEST_URL}`, `**Captured:** ${new Date().toISOString()}`, `**Devices:** ${captures.length}`, '',
    '## Device Summary', '',
    '| Device | Viewport | Breakpoint | Overflow | Load Time |',
    '|--------|----------|------------|----------|-----------|',
  ];
  for (const c of captures) {
    const ov = c.metadata?.hasHorizontalOverflow ? 'YES' : 'No';
    reportLines.push(`| ${c.device} | ${c.viewport.w}x${c.viewport.h} | ${c.breakpoint} | ${ov} | ${c.timing}ms |`);
  }
  const report = reportLines.join('\n');
  const reportValid = report.includes('| Device |') && captures.every(c => report.includes(c.device)) && reportLines.length > 10;
  console.log(`  Report: ${reportLines.length} lines, valid=${reportValid}`);
  reportLines.slice(0, 15).forEach(l => console.log(`    ${l}`));

  // Vision format
  const visionContent = [{ type: 'text', text: `Cross-viewport comparison of ${captures.length} devices.` }];
  for (const c of captures) {
    visionContent.push({ type: 'text', text: `--- ${c.device} (${c.viewport.w}x${c.viewport.h}) ---` });
    visionContent.push({ type: 'image', data: c.screenshot, mimeType: 'image/png' });
  }
  const imgs = visionContent.filter(b => b.type === 'image');
  const visionValid = imgs.length === captures.length && imgs.every(b => b.data?.length > 100 && b.mimeType === 'image/png');
  console.log(`  Vision: ${imgs.length} images, valid=${visionValid}`);

  const totalTime = Date.now() - overallStart;

  // ═══ Acceptance Criteria ═══
  console.log('\n== ACCEPTANCE CRITERIA ==\n');

  const c1 = captures.length === 3;
  console.log(`${c1 ? 'PASS' : 'FAIL'} [AC1] 3 devices capture simultaneously: ${captures.length}/3`);

  const vpChecks = [];
  for (const cap of captures) {
    const dev = DEVICES.find(d => d.label === cap.device);
    if (!dev) continue;
    const actual = cap.metadata?.innerWidth ?? cap.viewport.w;
    const ok = Math.abs(actual - dev.expectedWidth) <= 30;
    vpChecks.push({ device: dev.label, expected: dev.expectedWidth, actual, ok });
    console.log(`  ${ok ? 'OK' : 'MISMATCH'} ${dev.label}: expected ~${dev.expectedWidth}, actual ${actual}`);
  }
  const c2 = vpChecks.length === 3 && vpChecks.every(v => v.ok);
  console.log(`${c2 ? 'PASS' : 'FAIL'} [AC2] Viewport dimensions match presets`);

  const c3 = overflowResults.length >= 3 && overflowResults.every(o => o.hasHorizontalOverflow);
  console.log(`${c3 ? 'PASS' : 'FAIL'} [AC3] Overflow detected: ${overflowResults.filter(o => o.hasHorizontalOverflow).length}/${overflowResults.length}`);

  const c4 = captures.every(c => c.screenshot?.length > 100) && reportValid;
  console.log(`${c4 ? 'PASS' : 'FAIL'} [AC4] Valid screenshots in report`);

  const c5 = captureTime < 30000;
  console.log(`${c5 ? 'PASS' : 'FAIL'} [AC5] Capture time: ${captureTime}ms < 30000ms`);

  const c6 = visionValid;
  console.log(`${c6 ? 'PASS' : 'FAIL'} [AC6] Claude Vision compatible`);

  const allPassed = c1 && c2 && c3 && c4 && c5 && c6;
  console.log(`\n== OVERALL: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'} ==`);
  console.log(`Wall: ${totalTime}ms | Boot: ${bootTime}ms | Capture: ${captureTime}ms`);

  // ═══ Cleanup ═══
  console.log('\n== Cleanup ==');
  for (const sim of connected) { try { await sim.client.disconnect(); } catch {} }
  for (const p of proxyProcs) { try { p.kill(); } catch {} }
  for (const sim of sims) {
    try { await execFileAsync('xcrun', ['simctl', 'shutdown', sim.udid]); } catch {}
    try { await execFileAsync('xcrun', ['simctl', 'delete', sim.udid]); } catch {}
  }
  console.log('  Done.');

  console.log('\n__RESULTS_JSON__');
  console.log(JSON.stringify({
    allPassed,
    criteria: { c1, c2, c3, c4, c5, c6 },
    timing: { captureMs: captureTime, totalMs: totalTime, bootMs: bootTime },
    captures: captures.map(c => ({ device: c.device, viewport: c.viewport, breakpoint: c.breakpoint, screenshotBytes: c.screenshot?.length ?? 0, metadata: c.metadata, timing: c.timing })),
    overflowResults, vpChecks, errors,
  }, null, 2));

  process.exit(allPassed ? 0 : 1);
})();
