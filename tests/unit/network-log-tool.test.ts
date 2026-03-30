import { EventEmitter } from 'events';
class MockClient extends EventEmitter {
  onConsole(): void {}
  onRequest(h: (r: { url: string; method: string }) => void): void { this.on('request', h); }
  onResponse(h: (r: { url: string; status: number }) => void): void { this.on('response', h); }
  isConnected() { return true; }
}
beforeEach(() => { jest.resetModules(); });
function load() {
  const { MCPServer, setWebKitClient } = require('../../src/mcp-server');
  const { registerNetworkLogTool } = require('../../src/tools/network-log');
  return { MCPServer, setWebKitClient, registerNetworkLogTool };
}
describe('network_log tool', () => {
  test('start/capture/filter/stop/clear', async () => {
    const { MCPServer, setWebKitClient, registerNetworkLogTool } = load();
    const s = new MCPServer(), mc = new MockClient();
    setWebKitClient(mc); registerNetworkLogTool(s);
    const h = s.getToolHandler('network_log')!;
    let r = JSON.parse((await h('s', { action: 'start' })).content![0].text!);
    expect(r.status).toBe('monitoring');
    mc.emit('request', { url: 'https://api.example.com/data', method: 'POST' });
    mc.emit('response', { url: 'https://api.example.com/data', status: 200 });
    mc.emit('request', { url: 'https://cdn.example.com/img.png', method: 'GET' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(3);
    expect(r.entries[0].type).toBe('request');
    expect(r.entries[1].status).toBe(200);
    r = JSON.parse((await h('s', { action: 'get', urlFilter: 'api\\.example' })).content![0].text!);
    expect(r.count).toBe(2);
    r = JSON.parse((await h('s', { action: 'stop' })).content![0].text!);
    expect(r.status).toBe('stopped');
    mc.emit('request', { url: 'https://x.com', method: 'GET' });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(3);
    await h('s', { action: 'get', clear: true });
    r = JSON.parse((await h('s', { action: 'get' })).content![0].text!);
    expect(r.count).toBe(0);
    setWebKitClient(null);
  });
  test('error when no client', async () => {
    const { MCPServer, setWebKitClient, registerNetworkLogTool } = load();
    const s = new MCPServer(); setWebKitClient(null); registerNetworkLogTool(s);
    const r = await s.getToolHandler('network_log')!('s', { action: 'start' });
    expect(r.isError).toBe(true);
  });
});
