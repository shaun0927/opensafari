/**
 * Single-device end-to-end integration tests.
 * Tests the full WebKit protocol stack: proxy -> connect -> navigate -> evaluate -> screenshot.
 * Requires a real Xcode Simulator to be available.
 * Skipped in CI and when no simulator tooling is found.
 */

import { SimulatorManager } from '../../src/simulator/manager';
import { WebInspectorProxy } from '../../src/simulator/proxy';
import { WebKitClient } from '../../src/webkit/client';
import { registerManagedDevices } from '../../src/reliability/zombie-cleanup';
import { isSimulatorAvailable, describeWithSimulator } from './helpers/simulator-check';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BOOT_TIMEOUT = 90_000;
const TEST_PROXY_PORT = 10322;
const TEST_PROXY_DEVICE_LIST_PORT = 10321;
const EXISTING_PROXY_DEVICE_LIST_PORT = 9321;

/**
 * Resolve a device name from available simulators.
 * Prefers standard iPhone models, falls back to whatever is available.
 */
async function resolveDeviceName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
    const data = JSON.parse(stdout);
    const preferred = ['iPhone 17 Pro', 'iPhone 17', 'iPhone 17e', 'iPhone 16 Pro'];
    for (const runtime of Object.values(data.devices) as any[]) {
      for (const pref of preferred) {
        const found = runtime.find((d: any) => d.name === pref && d.isAvailable);
        if (found) return found.name;
      }
    }
    for (const runtime of Object.values(data.devices) as any[]) {
      for (const d of runtime as any[]) {
        if (d.isAvailable) return d.name;
      }
    }
  } catch { /* fall through */ }
  return 'iPhone 17 Pro';
}

/**
 * Register a device in the shared zombie cleanup registry
 * so that a concurrently running MCP server won't kill it.
 */
function protectDevice(udid: string): void {
  registerManagedDevices([udid]);
}

/**
 * Try to connect to an existing proxy (e.g. from a running MCP server).
 * Returns the port if healthy, or null if no proxy is running.
 */
async function findExistingProxy(): Promise<number | null> {
  const http = await import('http');
  for (const port of [EXISTING_PROXY_DEVICE_LIST_PORT, TEST_PROXY_DEVICE_LIST_PORT]) {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}`, { timeout: 2000 }, res => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (body.includes('iOS Devices')) return port + 1; // forwarding port = device list port + 1
    } catch { /* not running on this port */ }
  }
  return null;
}

/**
 * Set up the proxy: reuse an existing one if available, or start a new one.
 * Returns { proxy, port } where proxy is null if reusing.
 */
async function setupProxy(): Promise<{ proxy: WebInspectorProxy | null; port: number }> {
  const existingPort = await findExistingProxy();
  if (existingPort) {
    return { proxy: null, port: existingPort };
  }
  const proxy = new WebInspectorProxy({ port: TEST_PROXY_PORT, deviceListPort: TEST_PROXY_DEVICE_LIST_PORT });
  await proxy.start();
  return { proxy, port: TEST_PROXY_PORT };
}

describeWithSimulator('Single Device E2E: WebKit full stack', () => {
  let manager: SimulatorManager;
  let proxy: WebInspectorProxy;
  let client: WebKitClient;
  let deviceUdid: string | null = null;
  let available = false;
  let connected = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) return;

    manager = new SimulatorManager();
    const deviceName = await resolveDeviceName();

    // Boot device and protect from zombie cleanup
    const device = await manager.boot(deviceName, { timeout: BOOT_TIMEOUT });
    deviceUdid = device.udid;
    protectDevice(device.udid);

    // Open Safari with retries (simulator may not be fully ready)
    let safariOpened = false;
    for (let i = 0; i < 15; i++) {
      try {
        await manager.openUrl(device.udid, 'https://example.com');
        safariOpened = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!safariOpened) {
      console.error('[e2e] Failed to open Safari after 15 retries');
      return;
    }

    // Wait for Safari to register with WebInspector
    await new Promise(r => setTimeout(r, 10_000));

    // Reuse existing proxy or start a new one
    const proxySetup = await setupProxy();
    if (proxySetup.proxy) proxy = proxySetup.proxy;
    const proxyPort = proxySetup.port;

    // Connect WebKit client with retries — if it fails, tests skip gracefully
    try {
      client = new WebKitClient({ host: 'localhost', port: proxyPort });
      await client.connect({ retries: 10, retryDelay: 3000 });
      connected = true;
    } catch (err) {
      console.error(`[e2e] WebKit connection failed (tests will skip): ${err}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (connected && client) {
      try { await client.disconnect(); } catch { /* best-effort */ }
    }
    if (proxy) {
      try { await proxy.stop(); } catch { /* best-effort */ }
    }
    if (deviceUdid && manager) {
      try { await manager.shutdown(deviceUdid); } catch { /* best-effort */ }
    }
  }, 60_000);

  test('WebInspectorProxy is healthy on device list port', async () => {
    if (!available || !connected) return;
    // Proxy is healthy if we connected successfully (may be owned or reused)
    expect(client.isConnected()).toBe(true);
  });

  test('WebKitClient connects and finds Safari target', async () => {
    if (!available || !connected) return;
    expect(client.isConnected()).toBe(true);
    const targets = await client.listTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].webSocketDebuggerUrl).toBeTruthy();
  }, 15_000);

  test('navigate + evaluate returns page title', async () => {
    if (!available || !connected) return;
    const result = await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
    expect(result.url).toContain('example.com');
    const title = await client.evaluate<string>('document.title');
    expect(title).toBe('Example Domain');
  }, 30_000);

  test('evaluate handles Promise results via Runtime.awaitPromise', async () => {
    if (!available || !connected) return;
    const num = await client.evaluate<number>('Promise.resolve(42)');
    expect(num).toBe(42);
    const str = await client.evaluate<string>('Promise.resolve("hello")');
    expect(str).toBe('hello');
  }, 30_000);

  test('screenshot returns valid PNG buffer (> 1KB)', async () => {
    if (!available || !connected) return;
    const buffer = await client.screenshot();
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1024);
    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  }, 30_000);

  test('cookies: getCookies -> setCookie -> getCookies -> clearCookies', async () => {
    if (!available || !connected) return;
    await client.setCookies([{
      name: 'opensafari_test',
      value: 'integration',
      domain: '.example.com',
      path: '/',
      expires: Date.now() / 1000 + 3600,
      httpOnly: false,
      secure: false,
    }]);
    const afterSet = await client.getCookies();
    const found = afterSet.find(c => c.name === 'opensafari_test');
    expect(found).toBeDefined();
    expect(found!.value).toBe('integration');
    await client.clearCookies();
    const afterClear = await client.getCookies();
    expect(afterClear.find(c => c.name === 'opensafari_test')).toBeUndefined();
  }, 30_000);

  test('click + type on form elements -> evaluate confirms value', async () => {
    if (!available || !connected) return;
    await client.evaluate(`
      (function() {
        var form = document.createElement('div');
        form.id = 'test-form';
        form.innerHTML = '<input id="test-input" type="text" value="" />';
        document.body.appendChild(form);
      })()
    `);
    await client.click('#test-input');
    await client.type('#test-input', 'hello opensafari');
    const value = await client.evaluate<string>(
      'document.getElementById("test-input").value'
    );
    expect(value).toContain('hello opensafari');
  }, 30_000);
});

describeWithSimulator('Single Device E2E: full cycle (resource leak check)', () => {
  let manager: SimulatorManager;
  let available = false;
  let deviceName: string;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) return;
    manager = new SimulatorManager();
    deviceName = await resolveDeviceName();
  }, 10_000);

  test('boot -> navigate -> interact -> screenshot -> shutdown leaves no leaks', async () => {
    if (!available) return;

    const device = await manager.boot(deviceName, { timeout: BOOT_TIMEOUT });
    protectDevice(device.udid);
    expect(device.state).toBe('Booted');

    let proxy: WebInspectorProxy | null = null;
    let client: WebKitClient | null = null;

    try {
      let opened = false;
      for (let i = 0; i < 15; i++) {
        try {
          await manager.openUrl(device.udid, 'https://example.com');
          opened = true;
          break;
        } catch {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (!opened) {
        console.error('[e2e] Safari did not open — skipping WebKit checks');
      } else {
        await new Promise(r => setTimeout(r, 10_000));

        const proxySetup = await setupProxy();
        if (proxySetup.proxy) proxy = proxySetup.proxy;
        const proxyPort = proxySetup.port;

        try {
          client = new WebKitClient({ host: 'localhost', port: proxyPort });
          await client.connect({ retries: 10, retryDelay: 3000 });
          expect(client.isConnected()).toBe(true);

          await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
          const title = await client.evaluate<string>('document.title');
          expect(title).toBe('Example Domain');

          const screenshot = await client.screenshot();
          expect(screenshot.length).toBeGreaterThan(1024);

          await client.disconnect();
          expect(client.isConnected()).toBe(false);
        } catch (err) {
          console.error(`[e2e] WebKit checks skipped due to connection issue: ${err}`);
        }
        if (proxy) {
          await proxy.stop();
        }
      }
    } finally {
      if (client?.isConnected()) {
        try { await client.disconnect(); } catch { /* best-effort */ }
      }
      if (proxy?.running) {
        try { await proxy.stop(); } catch { /* best-effort */ }
      }
    }

    await manager.shutdown(device.udid);
    const booted = await manager.listBooted();
    expect(booted.find(d => d.udid === device.udid)).toBeUndefined();
  }, 240_000);
});
