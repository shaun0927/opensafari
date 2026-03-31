// Phase 1: Save auth profile on example.com
const path = require('path');
const fs = require('fs');
const { WebKitClient, AuthManager } = require('../dist/index.js');

const TEST_AUTH_DIR = path.join(__dirname, '../.test-auth-273');
const PORT = parseInt(process.env.TEST_PORT || '9522');

async function main() {
  fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_AUTH_DIR, { recursive: true });

  const auth = new AuthManager(TEST_AUTH_DIR);
  const client = new WebKitClient({ host: 'localhost', port: PORT });
  await client.connect({ retries: 10, retryDelay: 2000 });

  // Set test data
  await client.evaluate(`
    document.cookie = "test_session=abc123; path=/; max-age=3600";
    document.cookie = "test_user=johndoe; path=/; max-age=3600";
    window.localStorage.setItem('auth_token', 'tok_test_12345');
    window.localStorage.setItem('user_pref', 'dark_mode');
  `);

  const filePath = await auth.save('example.com', client);
  const profile = await auth.loadProfile('example.com');
  console.log(JSON.stringify({ ok: true, cookies: profile.cookies.length, localStorage: Object.keys(profile.localStorage).length, filePath }));

  await client.disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
