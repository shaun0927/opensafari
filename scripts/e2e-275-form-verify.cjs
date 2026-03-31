/**
 * E2E Verification Script for Issue #275
 * Compound scenario — form submission with validation and multi-step verification
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const START = Date.now();
const results = [];
const UDID = 'D7D26213-C3E9-4623-BCCB-984CDF5D0793';
const PROXY_PORT = 9522;
const DEVICE_LIST_PORT = 9521;

function elapsed() { return ((Date.now() - START) / 1000).toFixed(1); }
function log(msg) { console.error(`[${elapsed()}s] ${msg}`); }
function pass(ac, detail) { results.push({ ac, pass: true, detail }); log(`PASS AC#${ac}: ${detail}`); }
function fail(ac, detail) { results.push({ ac, pass: false, detail }); log(`FAIL AC#${ac}: ${detail}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function waitForProxy(port, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const data = await httpGet(`http://localhost:${port}/json`);
      const pages = JSON.parse(data);
      if (pages.length > 0) return pages;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`Proxy not ready on port ${port} within ${timeout}ms`);
}

async function main() {
  log('Starting Issue #275 E2E verification...');

  // Load opensafari
  const mod = await import(path.join(__dirname, '..', 'dist', 'index.js'));
  const { SimulatorManager, WebKitClient } = mod.default || mod;

  // Step 1: Ensure proxy is running on our dedicated port
  log('Checking proxy...');
  let proxyProc = null;
  try {
    const pages = JSON.parse(await httpGet(`http://localhost:${PROXY_PORT}/json`));
    log(`Proxy already running with ${pages.length} page(s)`);
  } catch {
    // Need to start proxy
    log('Starting proxy...');
    // Find live socket
    let socketPath;
    try {
      const lsofOut = execSync('lsof -U 2>/dev/null | grep webinspectord_sim', { encoding: 'utf8' });
      const m = lsofOut.match(/(\/private\/var\/tmp\/[^\s]+webinspectord_sim\.socket)/);
      if (m) socketPath = m[1];
    } catch {}
    if (!socketPath) throw new Error('No live webinspectord socket. Boot simulator and open Safari first.');
    log(`Socket: ${socketPath}`);
    proxyProc = spawn('ios_webkit_debug_proxy', [
      '-s', `unix:${socketPath}`,
      '-c', `null:${DEVICE_LIST_PORT},:${PROXY_PORT}-${PROXY_PORT + 100}`,
      '-F'
    ], { stdio: 'ignore', detached: true });
    proxyProc.unref();
    const pages = await waitForProxy(PROXY_PORT, 15000);
    log(`Proxy started with ${pages.length} page(s)`);
  }

  // Step 6: Connect WebKitClient
  log('Connecting WebKitClient...');
  let client = new WebKitClient({ host: 'localhost', port: PROXY_PORT, connectTimeout: 15000 });
  await client.connect({ retries: 5, retryDelay: 3000 });
  log('WebKitClient connected!');

  // ========== Helper: inject HTML via evaluate ==========
  async function loadHTML(htmlContent) {
    // Extract body content and styles from full HTML, inject via innerHTML
    // This avoids document.write() which destroys the WebSocket target
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const styleMatch = htmlContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const scriptMatch = htmlContent.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);

    let bodyContent = bodyMatch ? bodyMatch[1] : htmlContent;
    // Remove script tags from body (we'll execute them separately)
    bodyContent = bodyContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    const styleCSS = styleMatch ? styleMatch[1] : '';

    await client.evaluate(`
      (function() {
        // Reset scroll
        window.scrollTo(0, 0);
        // Inject style
        var existingStyle = document.getElementById('injected-style');
        if (existingStyle) existingStyle.remove();
        var style = document.createElement('style');
        style.id = 'injected-style';
        style.textContent = ${JSON.stringify(styleCSS)};
        document.head.appendChild(style);
        // Set viewport meta
        var meta = document.querySelector('meta[name=viewport]');
        if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
        meta.content = 'width=device-width,initial-scale=1';
        // Inject body
        document.body.innerHTML = ${JSON.stringify(bodyContent)};
      })()
    `);

    // Execute scripts separately after DOM is ready
    if (scriptMatch) {
      for (const tag of scriptMatch) {
        const code = tag.replace(/<script[^>]*>/, '').replace(/<\/script>/i, '');
        if (code.trim()) {
          await client.evaluate(`(function(){${code}})()`);
        }
      }
    }
    await sleep(1000);
  }

  // ========== FORM HTML ==========
  const FORM_HTML = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui;padding:20px;max-width:400px;margin:0 auto}
.form-group{margin:15px 0}
label{display:block;margin-bottom:5px;font-weight:bold}
input,textarea{width:100%;padding:10px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px}
.error{color:red;font-size:14px;margin-top:5px;display:none}
.error.visible{display:block}
button{padding:12px 24px;background:#007AFF;color:white;border:none;border-radius:4px;cursor:pointer;font-size:16px;width:100%}
.success{background:#34C759;padding:20px;border-radius:8px;color:white;text-align:center;display:none}
.success.visible{display:block}
.result{margin-top:10px;padding:10px;background:rgba(255,255,255,0.2);border-radius:4px}
</style></head>
<body>
<h1>Contact Form</h1>
<form id="myForm" novalidate>
  <div class="form-group">
    <label for="name">Name *</label>
    <input id="name" type="text" required minlength="2" placeholder="Your name">
    <div id="nameError" class="error">Name is required (min 2 characters)</div>
  </div>
  <div class="form-group">
    <label for="email">Email *</label>
    <input id="email" type="email" required placeholder="your@email.com">
    <div id="emailError" class="error">Valid email is required</div>
  </div>
  <div class="form-group">
    <label for="message">Message *</label>
    <textarea id="message" required minlength="10" rows="4" placeholder="Your message (min 10 chars)"></textarea>
    <div id="messageError" class="error">Message is required (min 10 characters)</div>
  </div>
  <button type="submit" id="submitBtn">Submit</button>
</form>
<div id="success" class="success">
  <h2>Thank you!</h2>
  <p>Your form was submitted successfully.</p>
  <div id="resultData" class="result"></div>
</div>
<script>
document.getElementById('myForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var valid = true;
  ['name','email','message'].forEach(function(f) {
    var input = document.getElementById(f);
    var err = document.getElementById(f+'Error');
    if (!input.value || (input.minLength > 0 && input.value.length < input.minLength) ||
        (f === 'email' && !/^[^@]+@[^@]+\\.[^@]+$/.test(input.value))) {
      err.classList.add('visible'); valid = false;
    } else { err.classList.remove('visible'); }
  });
  if (valid) {
    document.getElementById('myForm').style.display = 'none';
    document.getElementById('success').classList.add('visible');
    document.getElementById('resultData').textContent =
      'Name: ' + document.getElementById('name').value +
      ', Email: ' + document.getElementById('email').value +
      ', Message: ' + document.getElementById('message').value;
  }
});
</script></body></html>`;

  // ========== AC#1: Invalid submission ==========
  log('--- AC#1: Invalid submission validation errors ---');
  try {
    await loadHTML(FORM_HTML);
    await client.click('#submitBtn');
    await sleep(1000);
    const page1 = await client.readPage();
    log(`Page after empty submit: ${page1.substring(0, 300)}`);
    const hasErrors = page1.includes('Name is required') && page1.includes('Valid email is required') && page1.includes('Message is required');
    if (hasErrors) pass(1, 'All validation errors detected via readPage');
    else fail(1, `Missing errors in: ${page1.substring(0, 200)}`);
  } catch (e) { fail(1, e.message); }

  // ========== AC#2: Correction and resubmission ==========
  log('--- AC#2: Correction and resubmission ---');
  try {
    await client.type('#name', 'John Doe');
    await client.type('#email', 'john@example.com');
    await client.type('#message', 'Hello, this is a test message for verification.');
    await sleep(500);
    await client.click('#submitBtn');
    await sleep(1500);
    const page2 = await client.readPage();
    log(`Page after valid submit: ${page2.substring(0, 300)}`);
    if (page2.includes('Thank you') && page2.includes('John Doe') && page2.includes('john@example.com')) {
      pass(2, 'Correction flow works, success state with submitted values shown');
    } else { fail(2, `Unexpected content: ${page2.substring(0, 200)}`); }
  } catch (e) { fail(2, e.message); }

  // ========== AC#3: Confirmation via screenshot + readPage ==========
  log('--- AC#3: Confirmation capture ---');
  try {
    const screenshot = await client.screenshot();
    fs.writeFileSync(path.join(__dirname, '..', 'e2e-275-confirmation.png'), screenshot);
    const page3 = await client.readPage();
    if (screenshot.length > 1000 && page3.includes('John Doe')) {
      pass(3, `Screenshot ${screenshot.length} bytes + readPage confirms submitted data`);
    } else { fail(3, `screenshot=${screenshot.length}, hasData=${page3.includes('John Doe')}`); }
  } catch (e) { fail(3, e.message); }

  // ========== Helper: reconnect client ==========
  async function reconnect() {
    try { await client.disconnect(); } catch {}
    await sleep(2000);
    client = new WebKitClient({ host: 'localhost', port: PROXY_PORT, connectTimeout: 15000 });
    await client.connect({ retries: 5, retryDelay: 2000 });
    log('Reconnected');
  }

  // ========== AC#4: Device rotation ==========
  log('--- AC#4: Device rotation ---');
  try {
    // Load fresh form for rotation test
    await loadHTML(FORM_HTML);
    const beforeContent = await client.readPage();

    // Rotate to landscape
    try { execSync(`xcrun simctl orientation ${UDID} landscape-right 2>&1`); } catch {}
    await sleep(3000);

    // Rotation may disconnect WebSocket — reconnect if needed
    let afterContent, afterScreenshot;
    try {
      afterContent = await client.readPage();
      afterScreenshot = await client.screenshot();
    } catch {
      log('Reconnecting after rotation...');
      await reconnect();
      afterContent = await client.readPage();
      afterScreenshot = await client.screenshot();
    }
    fs.writeFileSync(path.join(__dirname, '..', 'e2e-275-rotated.png'), afterScreenshot);

    // Rotate back
    try { execSync(`xcrun simctl orientation ${UDID} portrait 2>&1`); } catch {}
    await sleep(2000);
    // Reconnect after rotating back
    try { await client.readPage(); } catch { await reconnect(); }

    const formSurvived = afterContent.includes('Contact Form') && afterContent.includes('Name') && afterContent.includes('Email');
    if (formSurvived && afterScreenshot.length > 1000) {
      pass(4, `Form layout survives rotation: content intact, screenshot=${afterScreenshot.length} bytes`);
    } else { fail(4, `formSurvived=${formSurvived}, screenshot=${afterScreenshot.length}`); }
  } catch (e) { fail(4, e.message); }

  // ========== AC#5: Scroll-to-submit ==========
  log('--- AC#5: Scroll-to-submit ---');
  try {
    const LONG_FORM = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui;padding:20px;max-width:400px;margin:0 auto}
.form-group{margin:20px 0}
label{display:block;margin-bottom:5px;font-weight:bold}
input{width:100%;padding:12px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px}
button{padding:14px 24px;background:#007AFF;color:white;border:none;border-radius:4px;width:100%;font-size:16px;margin-top:20px}
.spacer{height:250px;background:linear-gradient(#f0f0f0,#e0e0e0);margin:10px 0;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#666}
#scrollResult{margin-top:20px;padding:15px;background:#34C759;color:white;border-radius:8px;display:none;text-align:center;font-size:18px}
</style></head>
<body>
<h1>Long Form</h1>
<form id="longForm">
  <div class="form-group"><label>Field 1</label><input value="val1"></div>
  <div class="spacer">Section A</div>
  <div class="form-group"><label>Field 2</label><input value="val2"></div>
  <div class="spacer">Section B</div>
  <div class="form-group"><label>Field 3</label><input value="val3"></div>
  <div class="spacer">Section C</div>
  <div class="form-group"><label>Field 4</label><input value="val4"></div>
  <div class="spacer">Section D</div>
  <button type="button" id="scrollSubmitBtn">Submit All</button>
  <div id="scrollResult"></div>
</form>
<script>
document.getElementById('scrollSubmitBtn').addEventListener('click', function() {
  document.getElementById('scrollResult').style.display='block';
  document.getElementById('scrollResult').textContent='SCROLL_SUBMIT_SUCCESS';
});
</script>
</body></html>`;

    await loadHTML(LONG_FORM);
    // Reset scroll position since loadHTML might retain old scroll
    await client.evaluate('window.scrollTo(0, 0)');
    await sleep(500);
    const scrollBefore = await client.evaluate('window.scrollY');
    await client.scroll('down', 600);
    await sleep(300);
    await client.scroll('down', 600);
    await sleep(300);
    await client.scroll('down', 600);
    await sleep(500);
    const scrollAfter = await client.evaluate('window.scrollY');
    log(`Scroll: ${scrollBefore} -> ${scrollAfter}`);
    // Scroll button into view and click
    await client.evaluate('document.getElementById("scrollSubmitBtn").scrollIntoView({block:"center"})');
    await sleep(500);
    await client.click('#scrollSubmitBtn');
    await sleep(1000);
    const page5 = await client.readPage();
    if (page5.includes('SCROLL_SUBMIT_SUCCESS') && scrollAfter > scrollBefore) {
      pass(5, `Scroll-to-submit works: scrolled ${scrollBefore}->${scrollAfter}, click succeeded`);
    } else { fail(5, `scrollSuccess=${page5.includes('SCROLL_SUBMIT_SUCCESS')}, scroll=${scrollBefore}->${scrollAfter}`); }
  } catch (e) { fail(5, e.message); }

  // ========== AC#6: Timing ==========
  const totalTime = (Date.now() - START) / 1000;
  if (totalTime <= 90) pass(6, `Completed in ${totalTime.toFixed(1)}s (< 90s)`);
  else fail(6, `Took ${totalTime.toFixed(1)}s (> 90s limit)`);

  // ========== Summary ==========
  console.error('\n====== ISSUE #275 VERIFICATION SUMMARY ======');
  let allPassed = true;
  for (const r of results) {
    console.error(`${r.pass ? 'PASS' : 'FAIL'} AC#${r.ac}: ${r.detail}`);
    if (!r.pass) allPassed = false;
  }
  console.error(`\nTotal: ${results.filter(r => r.pass).length}/${results.length} passed in ${totalTime.toFixed(1)}s`);
  console.error(allPassed ? '\nALL ACCEPTANCE CRITERIA VERIFIED!' : '\nSOME CRITERIA FAILED');
  console.log(JSON.stringify({ results, totalTime, allPassed }));

  // Cleanup
  try { await client.disconnect(); } catch {}
  try { proxyProc.kill(); } catch {}
}

main().catch(e => { console.error(`Fatal: ${e.message}\n${e.stack}`); process.exit(1); });
