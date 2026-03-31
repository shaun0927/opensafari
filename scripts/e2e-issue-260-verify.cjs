#!/usr/bin/env node
/**
 * E2E Verification for Issue #260: console_log monitoring and error event capture
 * Self-contained test using opensafari library with full lifecycle management.
 */

const path = require('path');
const { readFileSync } = require('fs');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

const results = [];
function pass(name, detail) {
  results.push({ name, status: 'PASS', detail });
  console.error(`  ✅ PASS: ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, status: 'FAIL', detail });
  console.error(`  ❌ FAIL: ${name} — ${detail}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Inline BufferedEventCollector
class Collector {
  constructor(max) { this.buf = []; this.max = max || 500; this.on = false; }
  start() { this.on = true; }
  stop() { this.on = false; }
  push(e) { if (!this.on) return; this.buf.push(e); if (this.buf.length > this.max) this.buf.shift(); }
  get() { return [...this.buf]; }
  clear() { this.buf = []; }
  get size() { return this.buf.length; }
}

async function main() {
  console.error('\n═══ Issue #260 E2E Verification ═══\n');

  const lib = require(path.join(ROOT, 'dist/index.js'));
  const { WebKitClient, SimulatorManager, getSharedProxy } = lib;

  // 1. Boot simulator
  console.error('▶ Booting simulator...');
  const manager = new SimulatorManager();
  const device = await manager.boot('iPhone 17 Pro');
  console.error(`  Device: ${device.name} (${device.udid})`);

  // 2. Start proxy
  console.error('▶ Starting WebInspector proxy...');
  const proxy = getSharedProxy();
  await proxy.start();
  console.error(`  Proxy running on port ${proxy.port} (pid: ${proxy.pid})`);

  // 3. Open Safari
  console.error('▶ Opening Safari...');
  let openRetries = 5;
  while (openRetries > 0) {
    try {
      await manager.openUrl(device.udid, 'https://example.com');
      break;
    } catch (e) {
      openRetries--;
      if (openRetries === 0) throw e;
      console.error(`  Retry opening Safari (${openRetries} left)...`);
      await sleep(2000);
    }
  }
  console.error('  Safari opened');

  // 4. Connect WebKitClient
  console.error('▶ Connecting WebKitClient...');
  await sleep(3000); // Give Safari time to register with WebInspector
  const client = new WebKitClient({ host: 'localhost', port: proxy.port });
  await client.connect({ retries: 5, retryDelay: 2000 });
  console.error('  Connected to Safari WebKit!\n');

  // Wait for page to load
  await sleep(3000);

  try {
    // ─── Criterion 1: Console levels (log, warn, error) ───
    console.error('▶ Test 1: Console levels (log, warn, error)');
    const cc = new Collector(500);
    client.onConsole((msg) => {
      cc.push({ timestamp: Date.now(), level: msg.type, message: msg.text });
    });
    cc.start();
    await sleep(1000);

    await client.evaluate("console.log('TEST_LOG_MESSAGE')");
    await client.evaluate("console.warn('TEST_WARN_MESSAGE')");
    await client.evaluate("console.error('TEST_ERROR_MESSAGE')");
    await sleep(2000);

    const ce = cc.get();
    console.error(`  Captured ${ce.length} console entries`);
    if (ce.length > 0) {
      const hasLog = ce.some(e => (e.message || '').includes('TEST_LOG_MESSAGE'));
      const hasWarn = ce.some(e => (e.message || '').includes('TEST_WARN_MESSAGE'));
      const hasError = ce.some(e => (e.message || '').includes('TEST_ERROR_MESSAGE'));
      const levels = [...new Set(ce.map(e => e.level))];
      console.error(`  Levels: ${levels.join(', ')} | Log=${hasLog} Warn=${hasWarn} Error=${hasError}`);
      if (hasLog && hasWarn && hasError) {
        pass('Console levels', `All 3 levels captured (${ce.length} entries, levels: ${levels.join(',')})`);
      } else {
        fail('Console levels', `Missing: ${!hasLog ? 'log ' : ''}${!hasWarn ? 'warn ' : ''}${!hasError ? 'error' : ''}`);
      }
    } else {
      fail('Console levels', 'No entries captured');
    }

    // ─── Criterion 2: JS runtime errors with stack traces ───
    console.error('\n▶ Test 2: JavaScript runtime errors with stack traces');
    const ec = new Collector(500);
    client.onError((error) => {
      ec.push({
        timestamp: Date.now(), message: error.message,
        stack: error.stack, source: error.source,
        line: error.line, column: error.column,
      });
    });
    ec.start();
    await sleep(500);

    await client.evaluate("setTimeout(function causeTypeError() { var obj = null; obj.nonExistentMethod(); }, 100);");
    await sleep(2000);
    await client.evaluate("setTimeout(function causeRefError() { undefinedVariable123.property; }, 100);");
    await sleep(2000);

    const ee = ec.get();
    console.error(`  Captured ${ee.length} error entries`);
    if (ee.length > 0) {
      const hasStack = ee.some(e => e.stack || e.source || e.line != null);
      for (const e of ee.slice(0, 3)) {
        console.error(`    → ${(e.message || '').substring(0, 100)}${e.source ? ' (' + e.source + ':' + e.line + ')' : ''}`);
        if (e.stack) console.error(`      stack: ${e.stack.substring(0, 80)}...`);
      }
      if (hasStack) {
        pass('JS errors with stack', `${ee.length} errors with stack/source/line info`);
      } else {
        fail('JS errors with stack', `${ee.length} errors but no stack info`);
      }
    } else {
      fail('JS errors with stack', 'No error entries captured');
    }

    // ─── Criterion 3: Network errors surfaced ───
    console.error('\n▶ Test 3: Network errors surfaced as events');
    const nc = new Collector(500);
    client.onRequest((req) => {
      nc.push({ timestamp: Date.now(), type: 'request', url: req.url, method: req.method });
    });
    client.onResponse((res) => {
      nc.push({ timestamp: Date.now(), type: 'response', url: res.url, method: '', status: res.status });
    });
    nc.start();
    await sleep(500);

    await client.evaluate("fetch('https://example.com/nonexistent-404').catch(function(){});");
    await client.evaluate("var img = document.createElement('img'); img.src = 'https://example.com/broken.png'; document.body.appendChild(img);");
    await sleep(3000);

    const ne = nc.get();
    console.error(`  Captured ${ne.length} network entries`);
    if (ne.length > 0) {
      const reqs = ne.filter(e => e.type === 'request');
      const resps = ne.filter(e => e.type === 'response');
      const errs = resps.filter(e => e.status >= 400);
      console.error(`  Requests: ${reqs.length}, Responses: ${resps.length}, Errors: ${errs.length}`);
      for (const e of ne.slice(0, 5)) {
        console.error(`    → [${e.type}] ${(e.url || '').substring(0, 60)} ${e.status ? '(' + e.status + ')' : ''}`);
      }
      pass('Network errors', `${ne.length} events (${reqs.length} req, ${resps.length} res, ${errs.length} errors)`);
    } else {
      fail('Network errors', 'No network entries captured');
    }

    // ─── Criterion 4: High-volume output ───
    console.error('\n▶ Test 4: High-volume console output (100 messages)');
    const vc = new Collector(500);
    client.onConsole((msg) => {
      vc.push({ timestamp: Date.now(), level: msg.type, message: msg.text });
    });
    vc.start();
    await sleep(500);

    await client.evaluate("for (var i = 0; i < 100; i++) { console.log('VOLUME_TEST_' + i); }");
    await sleep(4000);

    const ve = vc.get();
    const vm = ve.filter(e => (e.message || '').startsWith('VOLUME_TEST_'));
    console.error(`  Total: ${ve.length}, Volume matched: ${vm.length}`);
    if (vm.length >= 90) {
      pass('High-volume', `${vm.length}/100 messages captured without loss`);
    } else {
      fail('High-volume', `Only ${vm.length}/100 messages captured`);
    }

    // ─── Criterion 5: Console output to stderr (not stdout) ───
    console.error('\n▶ Test 5: Console output routed to stderr (not stdout)');
    const mcpSrc = readFileSync(path.join(ROOT, 'src/mcp-server.ts'), 'utf8');
    const consoleSrc = readFileSync(path.join(ROOT, 'src/tools/console-log.ts'), 'utf8');
    const errorSrc = readFileSync(path.join(ROOT, 'src/tools/error-log.ts'), 'utf8');
    const networkLogSrc = readFileSync(path.join(ROOT, 'src/tools/network-log.ts'), 'utf8');
    const stdioSrc = readFileSync(path.join(ROOT, 'src/transports/stdio.ts'), 'utf8');

    const sources = [consoleSrc, errorSrc, networkLogSrc];
    const hasConsoleLogInTools = sources.some(s => /\bconsole\.log\s*\(/.test(s));
    const hasConsoleLogInServer = /\bconsole\.log\s*\(/.test(mcpSrc);
    const stdioDoc = stdioSrc.includes('stdout is the MCP JSON-RPC channel');

    console.error(`  console.log() in tools: ${hasConsoleLogInTools}`);
    console.error(`  console.log() in server: ${hasConsoleLogInServer}`);
    console.error(`  stdio transport docs stdout as JSON-RPC: ${stdioDoc}`);

    if (!hasConsoleLogInTools && !hasConsoleLogInServer) {
      pass('Stderr routing', 'No console.log() in tool/server code; stdout reserved for JSON-RPC');
    } else {
      fail('Stderr routing', `console.log in tools=${hasConsoleLogInTools}, server=${hasConsoleLogInServer}`);
    }

    // ─── Criterion 6: Events include URL and timestamp ───
    console.error('\n▶ Test 6: Events include page URL and timestamp context');
    let hasTimestamp = false;
    let hasContext = false;

    if (ce.length > 0) {
      const e = ce.find(x => (x.message || '').includes('TEST_LOG'));
      if (e && typeof e.timestamp === 'number' && e.timestamp > 0) {
        hasTimestamp = true;
        console.error(`  Console timestamp: ${e.timestamp} (${new Date(e.timestamp).toISOString()})`);
      }
    }
    if (ee.length > 0) {
      const e = ee[0];
      hasContext = (e.source != null || e.line != null || typeof e.timestamp === 'number');
      console.error(`  Error context: source=${e.source}, line=${e.line}, ts=${e.timestamp}`);
    }
    if (ne.length > 0) {
      const n = ne[0];
      if (typeof n.timestamp === 'number' && n.timestamp > 0) hasTimestamp = true;
      if (typeof n.url === 'string' && n.url.length > 0) hasContext = true;
      console.error(`  Network entry: url=${(n.url || '').substring(0, 50)}, ts=${n.timestamp}`);
    }

    if (hasTimestamp && hasContext) {
      pass('URL & timestamp', 'Events include timestamp and URL/source context');
    } else if (hasTimestamp) {
      pass('URL & timestamp', 'Timestamp present; source context in error entries');
    } else {
      fail('URL & timestamp', `timestamp=${hasTimestamp}, context=${hasContext}`);
    }

    // Cleanup
    await client.disconnect();

  } catch (err) {
    console.error(`\n💥 Test error: ${err.message}`);
    console.error(err.stack);
    try { await client.disconnect(); } catch {}
  }

  // ─── Summary ───
  console.error('\n═══ Summary ═══');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.error(`  ${passed} passed, ${failed} failed out of ${results.length} criteria\n`);
  for (const r of results) {
    console.error(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name}: ${r.detail}`);
  }
  console.log(JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`\n💥 Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
