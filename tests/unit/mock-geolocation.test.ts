import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerMockGeolocationTool } from '../../src/tools/mock-geolocation';

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

describe('mock_geolocation tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerMockGeolocationTool(server);
  });

  afterEach(() => {
    setWebKitClient(null);
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('mock_geolocation');
  });

  test('returns error when Safari not connected', async () => {
    setWebKitClient(null);
    const handler = server.getToolHandler('mock_geolocation')!;
    const result = await handler('test', { latitude: 37.7749, longitude: -122.4194 });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('not connected');
  });

  test('injects geolocation override script', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_geolocation')!;
    const result = await handler('test', { latitude: 37.7749, longitude: -122.4194 });
    expect(result.isError).toBeUndefined();
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.status).toBe('mocked');
    expect(text.latitude).toBe(37.7749);
    expect(text.longitude).toBe(-122.4194);
    expect(text.accuracy).toBe(10);
    expect(mock.lastScript).toContain('37.7749');
    expect(mock.lastScript).toContain('-122.4194');
    expect(mock.lastScript).toContain('getCurrentPosition');
    expect(mock.lastScript).toContain('watchPosition');
  });

  test('passes custom accuracy and altitude', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_geolocation')!;
    const result = await handler('test', { latitude: 35.6762, longitude: 139.6503, accuracy: 50, altitude: 100 });
    const text = JSON.parse((result.content as any)[0].text);
    expect(text.accuracy).toBe(50);
    expect(text.altitude).toBe(100);
    expect(mock.lastScript).toContain('50');
    expect(mock.lastScript).toContain('100');
  });

  test('rejects invalid latitude', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_geolocation')!;
    const result = await handler('test', { latitude: 91, longitude: 0 });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('latitude');
  });

  test('rejects invalid longitude', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_geolocation')!;
    const result = await handler('test', { latitude: 0, longitude: 181 });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('longitude');
  });

  test('attempts Page.addScriptToEvaluateOnLoad for persistence', async () => {
    const mock = createMockClient();
    setWebKitClient(mock as any);
    const handler = server.getToolHandler('mock_geolocation')!;
    await handler('test', { latitude: 0, longitude: 0 });
    const persistCall = mock.calls.find((c) => c.method === 'Page.addScriptToEvaluateOnLoad');
    expect(persistCall).toBeDefined();
    expect((persistCall!.params as any).scriptSource).toContain('getCurrentPosition');
  });
});
