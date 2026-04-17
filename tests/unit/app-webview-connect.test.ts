import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerAppWebviewConnectTool } from '../../src/tools/app-webview-connect';

function createMockClient(targets: Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string; type?: string; appId?: string; bundleId?: string; app_id?: string }>) {
  return {
    async listTargets() { return targets; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    async navigate() { return { url: '', status: 200 }; },
    async screenshot() { return Buffer.alloc(0); },
    async readPage() { return ''; },
    async getCookies() { return []; },
    async setCookies() {},
    async clearCookies() {},
    async click() {},
    async type() {},
    async scroll() {},
    async longPress() {},
    async swipe() {},
    async press() {},
    async dismissKeyboard() {},
    async selectOption() {},
    async querySelector() { return null; },
    async querySelectorAll() { return []; },
    async inspect() { return {}; },
    async waitFor() {},
    async send() { return {}; },
    async evaluate() { return undefined; },
    on() {},
  };
}

const MIXED_TARGETS = [
  { id: 'page-1', title: 'Google', url: 'https://google.com', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1' },
  { id: 'page-2', title: 'MyApp WebView', url: 'file:///var/containers/App/WebView', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-2' },
  { id: 'page-3', title: 'App Content', url: 'about:blank', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-3' },
  { id: 'page-4', title: 'NativeWebView', url: 'app://com.example.app/home', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-4' },
];

describe('app_webview_connect tool', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
    registerAppWebviewConnectTool(server);
  });

  afterEach(() => {
    setWebKitClient(null);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_webview_connect');
  });

  test('returns WebView targets only (filters out Safari/http targets)', async () => {
    const mock = createMockClient(MIXED_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content as any)[0].text);
    // page-2 (file://) and page-4 (app://) are WebViews; page-1 (https) and page-3 (about:blank) are Safari
    expect(data.targets.map((t: any) => t.id)).toContain('page-2');
    expect(data.targets.map((t: any) => t.id)).toContain('page-4');
    expect(data.targets.map((t: any) => t.id)).not.toContain('page-1');
    expect(data.targets.map((t: any) => t.id)).not.toContain('page-3');
  });

  test('returns count matching number of WebView targets', async () => {
    const mock = createMockClient(MIXED_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.count).toBe(2);
    expect(data.targets).toHaveLength(2);
  });

  test('returns count 0 and empty targets when no WebView targets exist', async () => {
    const safariOnly = [
      { id: 'page-1', title: 'Google', url: 'https://google.com', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1' },
      { id: 'page-2', title: 'New Tab', url: 'about:blank', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-2' },
    ];
    const mock = createMockClient(safariOnly);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.count).toBe(0);
    expect(data.targets).toHaveLength(0);
  });

  test('filters by bundleId when provided', async () => {
    const mock = createMockClient(MIXED_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    const data = JSON.parse((result.content as any)[0].text);
    // Only page-4 has 'com.example.app' in url
    expect(data.targets.map((t: any) => t.id)).toContain('page-4');
    expect(data.targets.map((t: any) => t.id)).not.toContain('page-2');
  });

  test('result includes deviceId field', async () => {
    const mock = createMockClient(MIXED_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    expect(data).toHaveProperty('deviceId');
  });

  test('targets do not expose webSocketDebuggerUrl', async () => {
    const mock = createMockClient(MIXED_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    for (const target of data.targets) {
      expect(target).not.toHaveProperty('webSocketDebuggerUrl');
    }
  });

  test('handles empty target list gracefully', async () => {
    const mock = createMockClient([]);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.count).toBe(0);
    expect(data.targets).toHaveLength(0);
  });

  // New tests for bundle-aware classification

  test('HTTPS payment-return target classified as webview when bundleId matches', async () => {
    const targets = [
      { id: 'page-pg', title: 'Payment', url: 'https://pay.example.com/return', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-pg', appId: 'com.example.shopping' },
    ];
    const mock = createMockClient(targets);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', { bundleId: 'com.example.shopping' });
    const data = JSON.parse((result.content as any)[0].text);
    const target = data.targets.find((t: any) => t.id === 'page-pg');
    expect(target).toBeDefined();
    expect(target.type).toBe('webview');
    expect(target.classificationReason).toBe('bundle_match');
  });

  test('HTTPS target with non-matching bundleId stays safari and is filtered out', async () => {
    const targets = [
      { id: 'page-pure', title: 'Google', url: 'https://google.com', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-pure' },
    ];
    const mock = createMockClient(targets);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', { bundleId: 'com.example.shopping' });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.targets.map((t: any) => t.id)).not.toContain('page-pure');
  });

  test('file:// target classified webview with reason url_scheme', async () => {
    const targets = [
      { id: 'page-file', title: 'x', url: 'file:///app/index.html', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-file' },
    ];
    const mock = createMockClient(targets);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    const target = data.targets.find((t: any) => t.id === 'page-file');
    expect(target).toBeDefined();
    expect(target.classificationReason).toBe('url_scheme');
  });

  test('proxy-supplied type=WebView overrides url_scheme', async () => {
    const targets = [
      { id: 'page-pt', title: 'x', url: 'https://cdn.example.com/frame.html', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-pt', type: 'WebView' },
    ];
    const mock = createMockClient(targets);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', {});
    const data = JSON.parse((result.content as any)[0].text);
    const target = data.targets.find((t: any) => t.id === 'page-pt');
    expect(target).toBeDefined();
    expect(target.type).toBe('webview');
    expect(target.classificationReason).toBe('proxy_type');
  });

  test('bundle_match by title substring still works for backward compatibility', async () => {
    const targets = [
      { id: 'page-legacy', title: 'com.example.app \u2013 Home', url: 'about:blank', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-legacy' },
    ];
    const mock = createMockClient(targets);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('app_webview_connect')!;
    const result = await handler('test', { bundleId: 'com.example.app' });
    const data = JSON.parse((result.content as any)[0].text);
    const target = data.targets.find((t: any) => t.id === 'page-legacy');
    expect(target).toBeDefined();
    expect(target.classificationReason).toBe('bundle_match');
    expect(target.type).toBe('webview');
  });
});
