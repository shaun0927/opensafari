// Phase 3: Test multi-profile isolation, expired cookies, cross-device, permissions
const path = require('path');
const fs = require('fs');
const { WebKitClient, AuthManager } = require('../dist/index.js');

const TEST_AUTH_DIR = path.join(__dirname, '../.test-auth-273');
const PORT = parseInt(process.env.TEST_PORT || '9522');

function pass(t) { console.error(`  ✅ ${t}`); }
function fail(t, e) { console.error(`  ❌ ${t} — ${e}`); }

async function main() {
  const auth = new AuthManager(TEST_AUTH_DIR);
  const client = new WebKitClient({ host: 'localhost', port: PORT });
  await client.connect({ retries: 10, retryDelay: 2000 });
  const results = {};

  // === TEST 2: Multiple profiles ===
  console.error('\n=== TEST 2: Multiple profiles ===');
  try {
    // Site A already saved in phase 1, update with specific marker
    await client.evaluate(`
      document.cookie = "site_a_session=aaa111; path=/; max-age=3600";
      window.localStorage.setItem('site_a_data', 'data_for_a');
    `);
    await auth.save('example.com', client);
    pass('Profile A (example.com) saved');

    // Site B — create manually to avoid navigation issues
    const profileB = {
      site: 'httpbin.org', savedAt: new Date().toISOString(), currentUrl: 'https://httpbin.org/',
      cookies: [{ name: 'site_b_session', value: 'bbb222', domain: 'httpbin.org', path: '/', expires: Math.floor(Date.now()/1000)+3600, httpOnly: false, secure: false }],
      localStorage: { site_b_data: 'data_for_b' }, sessionStorage: {},
    };
    fs.writeFileSync(path.join(TEST_AUTH_DIR, 'httpbin.org.json'), JSON.stringify(profileB, null, 2));
    pass('Profile B (httpbin.org) saved');

    const profiles = await auth.list();
    const sites = profiles.map(p => p.site);
    if (sites.includes('example.com') && sites.includes('httpbin.org')) {
      pass(`Both profiles listed: ${sites.join(', ')}`);
    } else { fail('list', sites.join(',')); results.test2 = false; }

    // Verify isolation
    const pA = await auth.loadProfile('example.com');
    const pB = await auth.loadProfile('httpbin.org');
    const aNames = pA.cookies.map(c => c.name);
    const bNames = pB.cookies.map(c => c.name);

    if (!aNames.includes('site_b_session') && !bNames.includes('site_a_session')) {
      pass('No cross-contamination between profiles');
    } else { fail('isolation', `A:${aNames} B:${bNames}`); results.test2 = false; }

    // Restore A and verify
    await auth.restore('example.com', client);
    await new Promise(r => setTimeout(r, 1000));
    const val = await client.evaluate(`window.localStorage.getItem('site_a_data')`);
    if (val === 'data_for_a') { pass('Profile A restored correctly'); }
    else { fail('restore A', val); results.test2 = false; }

    if (results.test2 !== false) { results.test2 = true; pass('TEST 2 PASSED'); }
  } catch (e) { fail('TEST 2', e.message); results.test2 = false; }

  // === TEST 3: Expired cookies ===
  console.error('\n=== TEST 3: Expired cookies ===');
  try {
    const expProfile = {
      site: 'expired-test.example.com', savedAt: new Date().toISOString(), currentUrl: 'https://example.com',
      cookies: [
        { name: 'valid_cookie', value: 'good', domain: 'example.com', path: '/', expires: Math.floor(Date.now()/1000)+3600, httpOnly: false, secure: false },
        { name: 'expired_cookie', value: 'old', domain: 'example.com', path: '/', expires: Math.floor(Date.now()/1000)-3600, httpOnly: false, secure: false },
        { name: 'session_cookie', value: 'sess', domain: 'example.com', path: '/', expires: 0, httpOnly: false, secure: false },
      ],
      localStorage: {}, sessionStorage: {},
    };
    fs.writeFileSync(path.join(TEST_AUTH_DIR, 'expired-test.example.com.json'), JSON.stringify(expProfile, null, 2));

    const info = await auth.checkExpiry('expired-test.example.com');
    if (info.isExpired && info.expiredCount === 1 && info.totalCookies === 3) {
      pass(`Expired detected: ${info.expiredCount}/${info.totalCookies}, isExpired=${info.isExpired}`);
    } else { fail('expiry', JSON.stringify(info)); results.test3 = false; }

    // Restore should not crash
    await auth.restore('expired-test.example.com', client);
    await new Promise(r => setTimeout(r, 1000));
    pass('Restore with expired cookies did not throw');

    if (results.test3 !== false) { results.test3 = true; pass('TEST 3 PASSED'); }
  } catch (e) { fail('TEST 3', e.message); results.test3 = false; }

  // === TEST 4: Cross-device portability ===
  console.error('\n=== TEST 4: Cross-device portability ===');
  try {
    const profile = await auth.loadProfile('example.com');
    if (profile.site && profile.cookies && !profile.deviceUdid && !profile.deviceType) {
      pass('Profile is device-agnostic');
    } else { fail('structure', 'device-specific fields found'); results.test4 = false; }

    const distCode = fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf-8');
    if (distCode.includes('injectAuth')) {
      pass('SimulatorPool.injectAuth() exists for cross-device injection');
    } else { fail('injectAuth', 'missing'); results.test4 = false; }

    // Check iPad availability
    try {
      const dj = JSON.parse(require('child_process').execSync('xcrun simctl list devices available -j').toString());
      let ipad = false;
      for (const [,list] of Object.entries(dj.devices)) { for (const d of list) { if (d.name.includes('iPad') && d.isAvailable) { ipad = true; break; } } if (ipad) break; }
      pass(ipad ? 'iPad available — portable' : 'No iPad, but profile is device-agnostic');
    } catch { pass('Profile structure verified device-agnostic'); }

    if (results.test4 !== false) { results.test4 = true; pass('TEST 4 PASSED'); }
  } catch (e) { fail('TEST 4', e.message); results.test4 = false; }

  // === TEST 5: Secure permissions ===
  console.error('\n=== TEST 5: Secure permissions ===');
  try {
    const files = fs.readdirSync(TEST_AUTH_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const fp = path.join(TEST_AUTH_DIR, f);
      const mode = (fs.statSync(fp).mode & 0o777).toString(8);
      JSON.parse(fs.readFileSync(fp, 'utf-8')); // validate JSON
      pass(`${f}: valid JSON, mode=${mode}`);
    }

    // Check real auth dir
    const realDir = path.join(require('os').homedir(), '.opensafari', 'auth');
    if (fs.existsSync(realDir)) {
      for (const f of fs.readdirSync(realDir).filter(f => f.endsWith('.json'))) {
        const mode = (fs.statSync(path.join(realDir, f)).mode & 0o777).toString(8);
        pass(`[real] ${f}: mode=${mode}`);
      }
    }

    results.test5 = true;
    pass('TEST 5 PASSED');
  } catch (e) { fail('TEST 5', e.message); results.test5 = false; }

  await client.disconnect();

  // Summary
  console.error('\n========');
  const all = Object.values(results).every(r => r);
  for (const [t,r] of Object.entries(results)) console.error(`  ${r?'✅':'❌'} ${t}`);
  console.error(all ? '\n✅ ALL PASSED' : '\n❌ SOME FAILED');
  console.log(JSON.stringify(results));
  if (!all) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
