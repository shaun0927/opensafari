/**
 * Multi-Tab E2E Integration Tests
 *
 * Tests TabPool + TabClient against a REAL iOS Simulator.
 * Covers: openTab + target discovery, parallel evaluate, parallel screenshot,
 * cross-tab event isolation, tab close + cleanup, and cross-tab cookie sharing.
 *
 * Requires Xcode + iOS Simulator tooling. Skipped in CI.
 */

import { SimulatorManager } from '../../src/simulator/manager';
import { WebInspectorProxy } from '../../src/simulator/proxy';
import { WebKitClient } from '../../src/webkit/client';
import { TabPool } from '../../src/simulator/tab-pool';
import { TabClient } from '../../src/simulator/tab-client';
import { registerManagedDevices } from '../../src/reliability/zombie-cleanup';
import { isSimulatorAvailable, describeWithSimulator } from './helpers/simulator-check';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BOOT_TIMEOUT = 90_000;
const TEST_PROXY_PORT = 11322;
const TEST_PROXY_DEVICE_LIST_PORT = 11321;
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

// ============================================================
// Multi-Tab E2E Test Suite
// ============================================================

describeWithSimulator('Multi-Tab E2E: TabPool + TabClient with real simulator', () => {
  let manager: SimulatorManager;
  let proxy: WebInspectorProxy | null = null;
  let client: WebKitClient;
  let tabPool: TabPool;
  let deviceUdid: string | null = null;
  let available = false;
  let connected = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) return;

    manager = new SimulatorManager();
    const deviceName = await resolveDeviceName();

    // Boot the simulator
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
      console.error('[multi-tab-e2e] Failed to open Safari after 15 retries');
      return;
    }

    // Wait for Safari to register with WebInspector
    await new Promise(r => setTimeout(r, 10_000));

    // Set up the proxy
    const proxySetup = await setupProxy();
    if (proxySetup.proxy) proxy = proxySetup.proxy;
    const proxyPort = proxySetup.port;

    // Connect WebKit client with retries
    try {
      client = new WebKitClient({ host: 'localhost', port: proxyPort });
      await client.connect({ retries: 10, retryDelay: 3000 });
      connected = true;
    } catch (err) {
      console.error(`[multi-tab-e2e] WebKit connection failed (tests will skip): ${err}`);
      return;
    }

    // Create TabPool for the connected device
    tabPool = new TabPool(client, device.udid, {
      maxTabs: 10,
      targetDiscoveryTimeout: 10_000,
    });
  }, 180_000);

  afterAll(async () => {
    // Clean up tabs
    if (tabPool) {
      try { await tabPool.closeAll(); } catch { /* best-effort */ }
    }
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

  /** Guard: skip individual tests when simulator/connection not available */
  function skipIfUnavailable(): boolean {
    return !available || !connected;
  }

  // ----------------------------------------------------------
  // Test 1: TabPool.openTab() + Target Discovery
  // ----------------------------------------------------------
  test('Test 1: openTab creates a new target and TabClient is functional', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // The default tab (from the initial Safari open) should exist
    const defaultTab = await tabPool.getDefaultTab();
    expect(defaultTab).toBeInstanceOf(TabClient);

    // Open a new tab
    const newTab = await tabPool.openTab('https://example.com');
    expect(newTab).toBeInstanceOf(TabClient);

    // Verify /json shows at least 2 targets
    const targets = await client.listTargets();
    expect(targets.length).toBeGreaterThanOrEqual(2);

    // TabClient has a valid targetId
    const targetId = newTab.getTargetId();
    expect(targetId).toBeTruthy();
    expect(typeof targetId).toBe('string');

    // isConnected() should be true
    expect(newTab.isConnected()).toBe(true);

    // Wait for page to load then evaluate document.title
    await new Promise(r => setTimeout(r, 3000));
    const title = await newTab.evaluate<string>('document.title');
    expect(title).toBe('Example Domain');
  }, 120_000);

  // ----------------------------------------------------------
  // Test 2: Multi-Tab Parallel Evaluate
  // ----------------------------------------------------------
  test('Test 2: parallel evaluate across 3 tabs returns correct results', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // Open tabs to distinct URLs
    // Tab 1: use the default tab, navigate to example.com
    const tab1 = await tabPool.getDefaultTab();
    await tab1.navigate({ url: 'https://example.com', waitUntil: 'load', timeout: 30_000 });

    // Tab 2: open httpbin.org/html
    const tab2 = await tabPool.openTab('https://httpbin.org/html');
    await new Promise(r => setTimeout(r, 3000));

    // Tab 3: open w3.org
    const tab3 = await tabPool.openTab('https://www.w3.org');
    await new Promise(r => setTimeout(r, 3000));

    // Parallel evaluate: each tab returns its own location.href
    const start = Date.now();
    const [href1, href2, href3] = await Promise.all([
      tab1.evaluate<string>('location.href'),
      tab2.evaluate<string>('location.href'),
      tab3.evaluate<string>('location.href'),
    ]);
    const elapsed = Date.now() - start;

    // Each result matches its tab's URL
    expect(href1).toContain('example.com');
    expect(href2).toContain('httpbin.org');
    expect(href3).toContain('w3.org');

    // Parallel execution should complete within 5 seconds
    expect(elapsed).toBeLessThan(5000);
  }, 120_000);

  // ----------------------------------------------------------
  // Test 3: Multi-Tab Parallel Screenshot
  // ----------------------------------------------------------
  test('Test 3: parallel screenshots from 2 tabs return valid distinct PNGs', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // Tab 1: navigate to a visually distinct page (white background, text)
    const tab1 = await tabPool.getDefaultTab();
    await tab1.navigate({ url: 'https://example.com', waitUntil: 'load', timeout: 30_000 });

    // Tab 2: open a visually different page
    const tab2 = await tabPool.openTab('https://httpbin.org/html');
    await new Promise(r => setTimeout(r, 3000));

    // Parallel screenshot
    const [screenshot1, screenshot2] = await Promise.all([
      tab1.screenshot(),
      tab2.screenshot(),
    ]);

    // Both return PNG buffers > 1KB
    expect(screenshot1).toBeInstanceOf(Buffer);
    expect(screenshot2).toBeInstanceOf(Buffer);
    expect(screenshot1.length).toBeGreaterThan(1024);
    expect(screenshot2.length).toBeGreaterThan(1024);

    // Both are valid PNGs (magic bytes: 0x89 0x50 0x4E 0x47)
    expect(screenshot1[0]).toBe(0x89);
    expect(screenshot1[1]).toBe(0x50);
    expect(screenshot1[2]).toBe(0x4e);
    expect(screenshot1[3]).toBe(0x47);
    expect(screenshot2[0]).toBe(0x89);
    expect(screenshot2[1]).toBe(0x50);
    expect(screenshot2[2]).toBe(0x4e);
    expect(screenshot2[3]).toBe(0x47);

    // Screenshots should differ (different pages produce different images)
    const differ = !screenshot1.equals(screenshot2);
    expect(differ).toBe(true);
  }, 120_000);

  // ----------------------------------------------------------
  // Test 4: Cross-Tab Event Isolation
  // ----------------------------------------------------------
  test('Test 4: console events are isolated per tab', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // Set up 2 tabs
    const tab1 = await tabPool.getDefaultTab();
    await tab1.navigate({ url: 'https://example.com', waitUntil: 'load', timeout: 30_000 });

    const tab2 = await tabPool.openTab('https://example.com');
    await new Promise(r => setTimeout(r, 3000));

    // Set up console handlers
    const tab1Messages: string[] = [];
    const tab2Messages: string[] = [];

    tab1.onConsole((msg) => {
      tab1Messages.push(msg.text);
    });
    tab2.onConsole((msg) => {
      tab2Messages.push(msg.text);
    });

    // Enable Runtime domain for console events
    await tab1.evaluate('1');
    await tab2.evaluate('1');

    // Fire console.log from tab1 only
    await tab1.evaluate('console.log("from-tab-1")');
    // Give time for event propagation
    await new Promise(r => setTimeout(r, 2000));

    // tab1 handler should receive the message
    expect(tab1Messages.some(m => m.includes('from-tab-1'))).toBe(true);

    // tab2 handler should NOT receive tab1's message
    expect(tab2Messages.some(m => m.includes('from-tab-1'))).toBe(false);
  }, 120_000);

  // ----------------------------------------------------------
  // Test 5: Tab Close + Listener Cleanup
  // ----------------------------------------------------------
  test('Test 5: closeTab removes tab and remaining tabs still work', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // Start fresh: close all previous tabs (except default)
    // and open 3 known tabs
    const tab1 = await tabPool.getDefaultTab();
    await tab1.navigate({ url: 'https://example.com', waitUntil: 'load', timeout: 30_000 });

    const tab2 = await tabPool.openTab('https://example.com');
    await new Promise(r => setTimeout(r, 2000));
    const tab2Id = tab2.getTargetId();

    const tab3 = await tabPool.openTab('https://example.com');
    await new Promise(r => setTimeout(r, 2000));

    const sizeBeforeClose = tabPool.size;
    expect(sizeBeforeClose).toBeGreaterThanOrEqual(3);

    // Close tab2
    await tabPool.closeTab(tab2Id);

    // Pool size should decrease by 1
    expect(tabPool.size).toBe(sizeBeforeClose - 1);

    // tab2 should be disconnected / no longer in pool
    expect(tabPool.getTab(tab2Id)).toBeNull();

    // tab1 and tab3 should still work
    const title1 = await tab1.evaluate<string>('document.title');
    expect(title1).toBeTruthy();

    const title3 = await tab3.evaluate<string>('document.title');
    expect(title3).toBeTruthy();

    // tab2 should report not connected
    expect(tab2.isConnected()).toBe(false);
  }, 120_000);

  // ----------------------------------------------------------
  // Test 6: Cross-Tab Cookie Sharing
  // ----------------------------------------------------------
  test('Test 6: cookies set on one tab are readable from another tab on the same domain', async () => {
    if (skipIfUnavailable()) return;
    jest.setTimeout(120_000);

    // Both tabs on example.com
    const tab1 = await tabPool.getDefaultTab();
    await tab1.navigate({ url: 'https://example.com', waitUntil: 'load', timeout: 30_000 });

    const tab2 = await tabPool.openTab('https://example.com');
    await new Promise(r => setTimeout(r, 3000));

    // Set a cookie on tab1
    const cookieName = `opensafari_e2e_${Date.now()}`;
    const cookieValue = 'cross-tab-test';
    await tab1.setCookies([{
      name: cookieName,
      value: cookieValue,
      domain: '.example.com',
      path: '/',
      expires: Date.now() / 1000 + 3600,
      httpOnly: false,
      secure: false,
    }]);

    // Brief wait for cookie propagation
    await new Promise(r => setTimeout(r, 1000));

    // Read cookies from tab2
    const tab2Cookies = await tab2.getCookies('example.com');
    const foundCookie = tab2Cookies.find(c => c.name === cookieName);
    expect(foundCookie).toBeDefined();
    expect(foundCookie!.value).toBe(cookieValue);

    // Clean up: remove the test cookie
    await tab1.clearCookies();
  }, 120_000);
});
