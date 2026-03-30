import { EventEmitter } from 'events';
class MockClient extends EventEmitter {
  onConsole(): void {}
  onRequest(): void {}
  onResponse(): void {}
  onError(h: (e: { message: string; stack?: string; source?: string; line?: number; column?: number }) => void): void {
    this.on('error_event', h);
  }
  isConnected() { return true; }
}
beforeEach(() => { jest.resetModules(); });
function load() {
  const { MCPServer, setWebKitClient } = require('../../src/mcp-server');
  const { registerErrorLogTool } = require('../../src/tools/error-log');
  return { MCPServer, setWebKitClient, registerErrorLogTool };
}
describe('error_log tool', () => {
  test('start/capture/stop/clear', async () => {
    const { MCPServer, setWebKitClient, registerErrorLogTool } = load();
    const s = new MCPServer(), mc = new MockClient();
    setWebKitClient(mc); registerErrorLogTool(s);
    const h = s.getToolHandler('error_log')!;
    let r = JSON.parse((await h('s', { action: 'start' })).content![0].text!);
    expect(r.status).toBe('capturing');
    mc.emit('error_event', { message: 'TypeError: x is undefined', stack: 'at foo.js:10', source: 'foo.js', line: 10, column: 5 });
    mc.emit('error_event', { message: 'ReferenceError: y' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(2);
    expect(r.entries[0].message).toContain('TypeError');
    expect(r.entries[0].line).toBe(10);
    r = JSON.parse((await h('s', { action: 'stop' })).content![0].text!);
    expect(r.status).toBe('stopped');
    mc.emit('error_event', { message: 'after stop' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(2);
    await h('s', { action: 'get', clear: true });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(0);
    setWebKitClient(null);
  });
  test('error when no client', async () => {
    const { MCPServer, setWebKitClient, registerErrorLogTool } = load();
    const s = new MCPServer(); setWebKitClient(null); registerErrorLogTool(s);
    const r = await s.getToolHandler('error_log')!('s', { action: 'start' });
    expect(r.isError).toBe(true);
  });
});
