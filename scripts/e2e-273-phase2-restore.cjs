// Phase 2: Restore auth profile after reboot and verify
const path = require('path');
const { WebKitClient, AuthManager } = require('../dist/index.js');

const TEST_AUTH_DIR = path.join(__dirname, '../.test-auth-273');
const PORT = parseInt(process.env.TEST_PORT || '9522');

async function main() {
  const auth = new AuthManager(TEST_AUTH_DIR);
  const client = new WebKitClient({ host: 'localhost', port: PORT });
  await client.connect({ retries: 10, retryDelay: 2000 });

  // Restore
  await auth.restore('example.com', client);
  await new Promise(r => setTimeout(r, 2000));

  // Verify cookies
  const cookies = await client.getCookies();
  const found = cookies.find(c => c.name === 'test_session');
  const cookieOk = found && found.value === 'abc123';

  // Verify localStorage
  const token = await client.evaluate(`window.localStorage.getItem('auth_token')`);
  const storageOk = token === 'tok_test_12345';

  console.log(JSON.stringify({ cookieOk, storageOk, cookieNames: cookies.map(c => c.name), token }));
  await client.disconnect();
  if (!cookieOk || !storageOk) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
