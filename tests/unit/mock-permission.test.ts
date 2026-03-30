import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerMockPermissionTool } from '../../src/tools/mock-permission';

function createMockClient() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  let lastEvaluatedScript = '';
  return {
    calls,
    get lastScript() { return lastEvaluatedScript; },
    async evaluate(expression: string) {
      lastEvaluatedScript = expression;
      calls.push({ method: 'evaluate', params: { expression } });
      return undefined;
    },
    async send(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      return {};
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
    on() {},
  };
}

describe('mock_permission tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerMockPermissionTool(server);
  });

  afterEach(() => {
    setWebKitClient(null);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('mock_permission');
  });

  test('returns error when Safari not connected', async () => {
    setWebKitClient(null);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'geolocation', state: 'granted' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('not connected');
  });

  test('injects permission override for geolocation granted', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'geolocation', state: 'granted' });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.status).toBe('mocked');
    expect(text.permission).toBe('geolocation');
    expect(text.state).toBe('granted');
    expect(mock.lastScript).toContain('__opensafariPermissionMocks');
    expect(mock.lastScript).toContain('"geolocation"');
    expect(mock.lastScript).toContain('"granted"');
  });

  test('supports camera permission denied', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'camera', state: 'denied' });
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.permission).toBe('camera');
    expect(text.state).toBe('denied');
  });

  test('supports microphone permission prompt', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'microphone', state: 'prompt' });
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.permission).toBe('microphone');
    expect(text.state).toBe('prompt');
  });

  test('supports notifications permission', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'notifications', state: 'granted' });
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.permission).toBe('notifications');
    expect(text.state).toBe('granted');
  });

  test('rejects invalid permission type', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'bluetooth', state: 'granted' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('invalid permission');
  });

  test('rejects invalid state', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    const result = await handler('test', { permission: 'camera', state: 'blocked' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('invalid state');
  });

  test('attempts Page.addScriptToEvaluateOnLoad for persistence', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    await handler('test', { permission: 'geolocation', state: 'granted' });
    const persistCall = mock.calls.find((c) => c.method === 'Page.addScriptToEvaluateOnLoad');
    expect(persistCall).toBeDefined();
    expect((persistCall!.params as any).scriptSource).toContain('__opensafariPermissionMocks');
  });

  test('preserves original query for unmocked permissions', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_permission')!;
    await handler('test', { permission: 'camera', state: 'denied' });
    expect(mock.lastScript).toContain('originalQuery');
  });
});
