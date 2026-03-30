import { EventEmitter } from 'events';
import { MCPServer, setWebKitClient } from '../../src/mcp-server';
import { registerConsoleLogTool } from '../../src/tools/console-log';
import { BrowserBackend } from '../../src/types/browser-backend';

class MockClient extends EventEmitter {
  onConsole(h: (m: { type: string; text: string }) => void): void { this.on('console', h); }
  onRequest(): void {}
  onResponse(): void {}
  isConnected() { return true; }
}
describe('console_log tool', () => {
  test('start/capture/filter/stop/clear', async () => {
    const s = new MCPServer(), mc = new MockClient();
    setWebKitClient(mc as unknown as BrowserBackend); registerConsoleLogTool(s);
    const h = s.getToolHandler('console_log')!;
    let r = JSON.parse((await h('s', { action: 'start' })).content![0].text!);
    expect(r.status).toBe('collecting');
    mc.emit('console', { type: 'log', text: 'a' });
    mc.emit('console', { type: 'error', text: 'b' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(2);
    r = JSON.parse((await h('s', { action: 'get', level: 'error' })).content![0].text!);
    expect(r.count).toBe(1);
    expect(r.entries[0].message).toBe('b');
    r = JSON.parse((await h('s', { action: 'stop' })).content![0].text!);
    expect(r.status).toBe('stopped');
    expect(r.buffered).toBe(2);
    mc.emit('console', { type: 'log', text: 'c' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(2);
    await h('s', { action: 'get', clear: true });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(0);
    setWebKitClient(null);
  });
  test('error when no client', async () => {
    const s = new MCPServer(); setWebKitClient(null); registerConsoleLogTool(s);
    const r = await s.getToolHandler('console_log')!('s', { action: 'start' });
    expect(r.isError).toBe(true);
  });
});
