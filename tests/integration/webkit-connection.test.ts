/**
 * Integration tests for the WebKit connection pipeline.
 * These tests require macOS with Xcode and a booted iOS Simulator.
 *
 * Run with: npm run test:integration
 * Skip in CI: these are excluded from the default `npm test` run.
 */

import { SimulatorManager } from '../../src/simulator/manager';
import { WebInspectorProxy } from '../../src/simulator/proxy';
import { WebKitClient } from '../../src/webkit/client';

const DEVICE_NAME = 'iPhone 17 Pro';
const TEST_URL = 'https://example.com';
const TIMEOUT = 120_000; // simulator boot can be slow

describe('WebKit Connection Integration', () => {
  let manager: SimulatorManager;
  let proxy: WebInspectorProxy;
  let client: WebKitClient;
  let deviceUdid: string;

  beforeAll(async () => {
    manager = new SimulatorManager();

    // Boot simulator
    const device = await manager.boot(DEVICE_NAME);
    deviceUdid = device.udid;

    // Start proxy
    proxy = new WebInspectorProxy();
    await proxy.start();

    // Open Safari
    let openRetries = 5;
    while (openRetries > 0) {
      try {
        await manager.openUrl(deviceUdid, TEST_URL);
        break;
      } catch {
        openRetries--;
        if (openRetries === 0) throw new Error('Failed to open Safari');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Connect WebKit client
    client = new WebKitClient({ host: 'localhost', port: proxy.port });
    let connectRetries = 5;
    while (connectRetries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        await client.connect();
        break;
      } catch {
        connectRetries--;
        if (connectRetries === 0) throw new Error('Failed to connect WebKit');
      }
    }
  }, TIMEOUT);

  afterAll(async () => {
    try { await client?.disconnect(); } catch { /* best-effort */ }
    try { await proxy?.stop(); } catch { /* best-effort */ }
    try { await manager?.shutdown(deviceUdid); } catch { /* best-effort */ }
  }, 30_000);

  test('WebKitClient is connected', () => {
    expect(client.isConnected()).toBe(true);
  });

  test('navigate loads a page with status 200', async () => {
    const result = await client.navigate({ url: TEST_URL, waitUntil: 'load' });
    expect(result.url).toContain('example.com');
    expect(result.status).toBe(200);
  }, 30_000);

  test('evaluate returns correct JavaScript result', async () => {
    const title = await client.evaluate<string>('document.title');
    expect(title).toBe('Example Domain');
  });

  test('evaluate returns numeric values', async () => {
    const width = await client.evaluate<number>('window.innerWidth');
    expect(typeof width).toBe('number');
    expect(width).toBeGreaterThan(0);
  });

  test('readPage returns page text content', async () => {
    const text = await client.readPage();
    expect(text).toContain('Example Domain');
  });

  test('screenshot returns valid PNG buffer', async () => {
    const data = await client.screenshot();
    expect(data.length).toBeGreaterThan(100);
    // Verify PNG magic bytes
    expect(data[0]).toBe(0x89); // PNG signature
    expect(data[1]).toBe(0x50); // 'P'
    expect(data[2]).toBe(0x4E); // 'N'
    expect(data[3]).toBe(0x47); // 'G'
  }, 15_000);

  test('querySelector returns element info', async () => {
    const el = await client.querySelector('h1');
    expect(el).not.toBeNull();
    expect(el!.tag).toBe('h1');
    expect(el!.text).toContain('Example Domain');
    expect(el!.boundingBox).not.toBeNull();
  });

  test('type sets input value (cross-realm fix)', async () => {
    // Create a test input
    await client.evaluate(`
      var inp = document.createElement('input');
      inp.id = 'integration-test-input';
      inp.type = 'text';
      document.body.prepend(inp);
    `);

    await client.type('#integration-test-input', 'hello integration');

    const value = await client.evaluate<string>(
      'document.querySelector("#integration-test-input").value'
    );
    expect(value).toBe('hello integration');
  });

  test('click executes without error', async () => {
    await expect(client.click({ x: 100, y: 100 })).resolves.not.toThrow();
  });

  test('scroll executes without error', async () => {
    await expect(client.scroll('down', 100)).resolves.not.toThrow();
  });

  test('getCookies returns array', async () => {
    const cookies = await client.getCookies();
    expect(Array.isArray(cookies)).toBe(true);
  });

  test('disconnect closes cleanly', async () => {
    await client.disconnect();
    expect(client.isConnected()).toBe(false);

    // Reconnect for afterAll cleanup
    client = new WebKitClient({ host: 'localhost', port: proxy.port });
    await client.connect();
  });
});
