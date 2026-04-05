import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerSetActiveContextTool } from '../../src/tools/set-active-context';

const SAFARI_TARGET = { id: 'page-1', title: 'Google', url: 'https://google.com', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1' };
const WEBVIEW_TARGET = { id: 'page-2', title: 'App WebView', url: 'app://com.example.app/home', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-2' };
const ALL_TARGETS = [SAFARI_TARGET, WEBVIEW_TARGET];

function createMockClient(
  targets: typeof ALL_TARGETS,
  connectToUrlFn?: (wsUrl: string) => Promise<void>,
) {
  return {
    async listTargets() { return targets; },
    async connectToUrl(wsUrl: string) {
      if (connectToUrlFn) return connectToUrlFn(wsUrl);
    },
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

describe('set_active_context tool', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
    registerSetActiveContextTool(server);
  });

  afterEach(() => {
    setWebKitClient(null);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('set_active_context');
  });

  test('switching to safari context selects a Safari target', async () => {
    const connectedUrls: string[] = [];
    const mock = createMockClient(ALL_TARGETS, async (url) => { connectedUrls.push(url); });
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'safari' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.context).toBe('safari');
    expect(data.status).toBe('connected');
    // Should connect to Safari target's WS URL
    expect(connectedUrls).toContain(SAFARI_TARGET.webSocketDebuggerUrl);
  });

  test('switching to webview context with targetId selects that target', async () => {
    const connectedUrls: string[] = [];
    const mock = createMockClient(ALL_TARGETS, async (url) => { connectedUrls.push(url); });
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'webview', targetId: 'page-2' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.context).toBe('webview');
    expect(data.target.id).toBe('page-2');
    expect(data.status).toBe('connected');
    expect(connectedUrls).toContain(WEBVIEW_TARGET.webSocketDebuggerUrl);
  });

  test('returns error when targetId not found', async () => {
    const mock = createMockClient(ALL_TARGETS);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'webview', targetId: 'nonexistent-id' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('nonexistent-id');
  });

  test('returns error when no targets available', async () => {
    const mock = createMockClient([]);
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'safari' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('No targets available');
  });

  test('switching to webview without targetId auto-selects non-http target', async () => {
    const connectedUrls: string[] = [];
    const mock = createMockClient(ALL_TARGETS, async (url) => { connectedUrls.push(url); });
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'webview' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.context).toBe('webview');
    // Should have auto-selected the app:// target
    expect(data.target.id).toBe('page-2');
  });

  test('result includes deviceId and target details', async () => {
    const mock = createMockClient(ALL_TARGETS, async () => {});
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('set_active_context')!;
    const result = await handler('test', { context: 'safari' });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data).toHaveProperty('deviceId');
    expect(data.target).toHaveProperty('id');
    expect(data.target).toHaveProperty('title');
    expect(data.target).toHaveProperty('url');
  });
});
