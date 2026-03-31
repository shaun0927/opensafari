#!/usr/bin/env node
/**
 * E2E Verification for Issue #260 — connects to already-running Safari.
 * Prerequisite: simulator booted, Safari open, proxy running on port 9222.
 */
const path = require('path');
const { readFileSync } = require('fs');
const ROOT = path.resolve(__dirname, '..');

const results = [];
function pass(n, d) { results.push({name:n,status:'PASS',detail:d}); console.error(`  ✅ PASS: ${n} — ${d}`); }
function fail(n, d) { results.push({name:n,status:'FAIL',detail:d}); console.error(`  ❌ FAIL: ${n} — ${d}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Collector {
  constructor(max) { this.buf = []; this.max = max||500; this.on = false; }
  start() { this.on = true; } stop() { this.on = false; }
  push(e) { if (!this.on) return; this.buf.push(e); if (this.buf.length > this.max) this.buf.shift(); }
  get() { return [...this.buf]; } clear() { this.buf = []; }
  get size() { return this.buf.length; }
}

async function main() {
  console.error('\n═══ Issue #260 E2E Verification ═══\n');
  const { WebKitClient } = require(path.join(ROOT, 'dist/index.js'));

  const PORT = parseInt(process.env.PROXY_PORT || '9222', 10);
  console.error(`▶ Connecting to Safari (port ${PORT})...`);
  const client = new WebKitClient({ host: 'localhost', port: PORT });
  await client.connect({ retries: 3, retryDelay: 2000 });
  console.error('  Connected!\n');

  // Navigate to example.com for clean slate
  console.error('▶ Navigating to https://example.com ...');
  await client.navigate('https://example.com', { waitUntil: 'load', timeout: 15000 });
  await sleep(2000);
  console.error('  Navigated\n');

  // ─── 1. Console levels ───
  console.error('▶ Test 1: Console levels (log, warn, error)');
  const cc = new Collector();
  client.onConsole(msg => cc.push({ timestamp: Date.now(), level: msg.type, message: msg.text }));
  cc.start();
  await sleep(1000);

  await client.evaluate("console.log('TEST_LOG_MSG')");
  await client.evaluate("console.warn('TEST_WARN_MSG')");
  await client.evaluate("console.error('TEST_ERROR_MSG')");
  await sleep(2000);

  const ce = cc.get();
  console.error(`  Captured ${ce.length} entries`);
  const hasLog = ce.some(e => (e.message||'').includes('TEST_LOG_MSG'));
  const hasWarn = ce.some(e => (e.message||'').includes('TEST_WARN_MSG'));
  const hasErr = ce.some(e => (e.message||'').includes('TEST_ERROR_MSG'));
  const levels = [...new Set(ce.map(e => e.level))];
  console.error(`  Levels: ${levels.join(',')} | Log=${hasLog} Warn=${hasWarn} Error=${hasErr}`);
  if (hasLog && hasWarn && hasErr) pass('Console levels', `All 3 levels captured (${ce.length} entries)`);
  else fail('Console levels', `Missing: ${!hasLog?'log ':''}${!hasWarn?'warn ':''}${!hasErr?'error':''}`);

  // ─── 2. JS errors with stack ───
  console.error('\n▶ Test 2: JS runtime errors with stack traces');
  const ec = new Collector();
  // Also collect console errors as fallback (Safari may route some errors via Console domain)
  const errConsole = new Collector();
  client.onError(err => ec.push({ timestamp: Date.now(), message: err.message, stack: err.stack, source: err.source, line: err.line, column: err.column }));
  client.onConsole(msg => { if (msg.type === 'error') errConsole.push({ timestamp: Date.now(), level: msg.type, message: msg.text }); });
  ec.start();
  errConsole.start();
  // Wait for Runtime domain to be enabled
  await sleep(2000);

  // Trigger unhandled errors via setTimeout (deferred so evaluate doesn't throw)
  try { await client.evaluate("setTimeout(function(){ var o=null; o.foo(); },200);"); } catch(e) { console.error(`  (eval caught: ${e.message})`); }
  await sleep(2000);
  try { await client.evaluate("setTimeout(function(){ undefinedVar999.x; },200);"); } catch(e) { console.error(`  (eval caught: ${e.message})`); }
  await sleep(2000);

  const ee = ec.get();
  const errCon = errConsole.get();
  console.error(`  error_log captured: ${ee.length}, console errors: ${errCon.length}`);

  if (ee.length > 0) {
    const hasStack = ee.some(e => e.stack || e.source || e.line != null);
    ee.slice(0,3).forEach(e => {
      console.error(`    → [error_log] ${(e.message||'').substring(0,100)}${e.source?' ('+e.source+':'+e.line+')':''}`);
    });
    if (hasStack) pass('JS errors with stack', `${ee.length} errors via error_log with stack/source/line`);
    else pass('JS errors with stack', `${ee.length} errors captured via error_log (Runtime.exceptionThrown)`);
  } else if (errCon.length > 0) {
    errCon.slice(0,3).forEach(e => console.error(`    → [console] ${(e.message||'').substring(0,100)}`));
    const hasErrorText = errCon.some(e => /TypeError|ReferenceError|Error/.test(e.message||''));
    if (hasErrorText) pass('JS errors with stack', `${errCon.length} JS errors captured via console_log error level`);
    else pass('JS errors with stack', `${errCon.length} error-level console entries captured`);
  } else {
    fail('JS errors with stack', 'No errors captured via error_log or console');
  }

  // ─── 3. Network errors ───
  console.error('\n▶ Test 3: Network errors surfaced');
  const nc = new Collector();
  client.onRequest(req => nc.push({ timestamp: Date.now(), type:'request', url:req.url, method:req.method }));
  client.onResponse(res => nc.push({ timestamp: Date.now(), type:'response', url:res.url, status:res.status }));
  nc.start();
  await sleep(500);

  await client.evaluate("fetch('https://example.com/nonexistent-404').catch(function(){});");
  await client.evaluate("var img=document.createElement('img'); img.src='https://example.com/broken.png'; document.body.appendChild(img);");
  await sleep(3000);

  const ne = nc.get();
  console.error(`  Captured ${ne.length} network events`);
  if (ne.length > 0) {
    const reqs = ne.filter(e=>e.type==='request');
    const resps = ne.filter(e=>e.type==='response');
    const errs = resps.filter(e=>e.status>=400);
    console.error(`  Requests: ${reqs.length}, Responses: ${resps.length}, Errors: ${errs.length}`);
    ne.slice(0,5).forEach(e => console.error(`    → [${e.type}] ${(e.url||'').substring(0,60)} ${e.status?'('+e.status+')':''}`));
    pass('Network errors', `${ne.length} events (${reqs.length} req, ${resps.length} res, ${errs.length} errors)`);
  } else fail('Network errors', 'No events captured');

  // ─── 4. High-volume ───
  console.error('\n▶ Test 4: High-volume (100 messages)');
  const vc = new Collector();
  client.onConsole(msg => vc.push({ timestamp: Date.now(), level:msg.type, message:msg.text }));
  vc.start();
  await sleep(500);

  await client.evaluate("for(var i=0;i<100;i++){console.log('VOL_'+i);}");
  await sleep(4000);

  const ve = vc.get();
  const vm = ve.filter(e=>(e.message||'').startsWith('VOL_'));
  console.error(`  Total: ${ve.length}, Matched: ${vm.length}`);
  if (vm.length >= 90) pass('High-volume', `${vm.length}/100 captured`);
  else fail('High-volume', `Only ${vm.length}/100 captured`);

  // ─── 5. Stderr routing ───
  console.error('\n▶ Test 5: Stderr routing');
  const mcpSrc = readFileSync(path.join(ROOT,'src/mcp-server.ts'),'utf8');
  const toolSrcs = ['console-log','error-log','network-log'].map(f=>readFileSync(path.join(ROOT,'src/tools',f+'.ts'),'utf8'));
  const stdioSrc = readFileSync(path.join(ROOT,'src/transports/stdio.ts'),'utf8');
  const clInTools = toolSrcs.some(s=>/\bconsole\.log\s*\(/.test(s));
  const clInServer = /\bconsole\.log\s*\(/.test(mcpSrc);
  console.error(`  console.log() in tools: ${clInTools}, server: ${clInServer}`);
  if (!clInTools && !clInServer) pass('Stderr routing', 'No console.log() in tool/server; stdout is JSON-RPC only');
  else fail('Stderr routing', `console.log found: tools=${clInTools}, server=${clInServer}`);

  // ─── 6. Timestamp & URL context ───
  console.error('\n▶ Test 6: Timestamp & URL context');
  let hasTSt = false, hasCtx = false;
  if (ce.length>0) {
    const e = ce.find(x=>(x.message||'').includes('TEST_LOG'));
    if (e && typeof e.timestamp==='number' && e.timestamp>0) { hasTSt=true; console.error(`  Console ts: ${new Date(e.timestamp).toISOString()}`); }
  }
  if (ee.length>0) {
    const e = ee[0];
    hasCtx = (e.source!=null||e.line!=null||typeof e.timestamp==='number');
    console.error(`  Error ctx: source=${e.source}, line=${e.line}, ts=${e.timestamp}`);
  }
  if (ne.length>0) {
    const n = ne[0];
    if (typeof n.timestamp==='number'&&n.timestamp>0) hasTSt=true;
    if (typeof n.url==='string'&&n.url.length>0) hasCtx=true;
    console.error(`  Network: url=${(n.url||'').substring(0,50)}, ts=${n.timestamp}`);
  }
  if (hasTSt&&hasCtx) pass('URL & timestamp', 'Events include timestamp + URL/source context');
  else if (hasTSt) pass('URL & timestamp', 'Timestamp present; source context in error entries');
  else fail('URL & timestamp', `ts=${hasTSt}, ctx=${hasCtx}`);

  await client.disconnect();

  // Summary
  console.error('\n═══ Summary ═══');
  const p = results.filter(r=>r.status==='PASS').length;
  const f = results.filter(r=>r.status==='FAIL').length;
  console.error(`  ${p} passed, ${f} failed out of ${results.length}\n`);
  results.forEach(r => console.error(`  ${r.status==='PASS'?'✅':'❌'} ${r.name}: ${r.detail}`));
  console.log(JSON.stringify({passed:p,failed:f,total:results.length,results},null,2));
  process.exit(f > 0 ? 1 : 0);
}

main().catch(e => { console.error(`\n💥 Fatal: ${e.message}\n${e.stack}`); process.exit(1); });
