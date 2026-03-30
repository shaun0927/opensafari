import { EventEmitter } from 'events';
import { HarCollector } from '../../src/network/har-collector';

class MockWebKitClient extends EventEmitter {
  public enableDomainCalled = false;
  public sendCalls: Array<{ method: string; params?: any }> = [];
  async enableDomain(_domain: string): Promise<void> { this.enableDomainCalled = true; }
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sendCalls.push({ method, params });
    if (method === 'Network.getResponseBody') return { body: '{"key":"value"}', base64Encoded: false } as T;
    return {} as T;
  }
}

function simulateRequest(client: MockWebKitClient, overrides?: any): void {
  client.emit('Network.requestWillBeSent', {
    requestId: overrides?.requestId ?? 'req-1', timestamp: overrides?.timestamp ?? Date.now() / 1000,
    request: { url: overrides?.url ?? 'https://example.com/api/data', method: overrides?.method ?? 'GET',
      headers: overrides?.headers ?? { 'Accept': 'application/json' }, postData: overrides?.postData },
  });
}

function simulateResponse(client: MockWebKitClient, overrides?: any): void {
  client.emit('Network.responseReceived', {
    requestId: overrides?.requestId ?? 'req-1', timestamp: overrides?.timestamp ?? Date.now() / 1000,
    response: { url: 'https://example.com/api/data', status: overrides?.status ?? 200,
      statusText: overrides?.statusText ?? 'OK', mimeType: overrides?.mimeType ?? 'application/json',
      headers: overrides?.headers ?? { 'Content-Type': 'application/json' }, encodedDataLength: overrides?.encodedDataLength ?? 1024 },
  });
}

describe('HarCollector', () => {
  let client: MockWebKitClient;
  beforeEach(() => { client = new MockWebKitClient(); });

  describe('lifecycle', () => {
    it('should start and stop recording', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      expect(collector.isRecording()).toBe(true);
      expect(client.enableDomainCalled).toBe(true);
      collector.stop();
      expect(collector.isRecording()).toBe(false);
    });

    it('should not start twice', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      await collector.start();
      expect(collector.isRecording()).toBe(true);
      collector.stop();
    });

    it('should clear entries', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      expect(collector.getEntryCount()).toBe(1);
      collector.clear();
      expect(collector.getEntryCount()).toBe(0);
      collector.stop();
    });
  });

  describe('request/response capture', () => {
    it('should capture a request', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      expect(collector.getEntryCount()).toBe(1);
      collector.stop();
    });

    it('should capture request and response pair', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      simulateResponse(client);
      await new Promise(r => setTimeout(r, 50));
      const har = collector.export('har') as any;
      expect(har.log.entries[0].request.method).toBe('GET');
      expect(har.log.entries[0].response.status).toBe(200);
      collector.stop();
    });

    it('should not capture events after stop', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      collector.stop();
      simulateRequest(client);
      expect(collector.getEntryCount()).toBe(0);
    });

    it('should ignore requests without request data', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      client.emit('Network.requestWillBeSent', { requestId: 'req-x' });
      expect(collector.getEntryCount()).toBe(0);
      collector.stop();
    });

    it('should parse query string from URL', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client, { url: 'https://example.com/search?q=test&page=1' });
      const har = collector.export('har') as any;
      expect(har.log.entries[0].request.queryString).toEqual([{ name: 'q', value: 'test' }, { name: 'page', value: '1' }]);
      collector.stop();
    });

    it('should capture POST data', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client, { method: 'POST', postData: '{"name":"test"}', headers: { 'Content-Type': 'application/json' } });
      const har = collector.export('har') as any;
      expect(har.log.entries[0].request.postData.text).toBe('{"name":"test"}');
      expect(har.log.entries[0].request.bodySize).toBe(15);
      collector.stop();
    });
  });

  describe('response body capture', () => {
    it('should not capture body by default', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      simulateResponse(client, { mimeType: 'application/json' });
      await new Promise(r => setTimeout(r, 50));
      expect(client.sendCalls.filter(c => c.method === 'Network.getResponseBody')).toHaveLength(0);
      collector.stop();
    });

    it('should capture body when captureBody is true', async () => {
      const collector = new HarCollector(client as any, { captureBody: true });
      await collector.start();
      simulateRequest(client);
      simulateResponse(client, { mimeType: 'application/json' });
      await new Promise(r => setTimeout(r, 50));
      expect(client.sendCalls.filter(c => c.method === 'Network.getResponseBody')).toHaveLength(1);
      const har = collector.export('har') as any;
      expect(har.log.entries[0].response.content.text).toBe('{"key":"value"}');
      collector.stop();
    });

    it('should skip body for binary content types', async () => {
      const collector = new HarCollector(client as any, { captureBody: true });
      await collector.start();
      simulateRequest(client);
      simulateResponse(client, { mimeType: 'image/png' });
      await new Promise(r => setTimeout(r, 50));
      expect(client.sendCalls.filter(c => c.method === 'Network.getResponseBody')).toHaveLength(0);
      collector.stop();
    });

    it('should skip body exceeding maxBodySize', async () => {
      const bigClient = new MockWebKitClient();
      bigClient.send = async <T = unknown>(method: string): Promise<T> => {
        if (method === 'Network.getResponseBody') return { body: 'x'.repeat(200), base64Encoded: false } as T;
        return {} as T;
      };
      const collector = new HarCollector(bigClient as any, { captureBody: true, maxBodySize: 100 });
      await collector.start();
      simulateRequest(bigClient);
      simulateResponse(bigClient, { mimeType: 'text/html' });
      await new Promise(r => setTimeout(r, 50));
      const har = collector.export('har') as any;
      expect(har.log.entries[0].response.content.text).toBeUndefined();
      collector.stop();
    });
  });

  describe('HAR 1.2 format', () => {
    it('should export valid HAR 1.2 structure', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      simulateResponse(client);
      await new Promise(r => setTimeout(r, 50));
      const har = collector.export('har') as any;
      expect(har.log.version).toBe('1.2');
      expect(har.log.creator).toEqual({ name: 'opensafari', version: '0.1.1' });
      expect(Array.isArray(har.log.pages)).toBe(true);
      expect(Array.isArray(har.log.entries)).toBe(true);
      collector.stop();
    });

    it('should include page with timing info', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      const har = collector.export('har') as any;
      expect(har.log.pages[0].id).toBe('page_0');
      expect(har.log.pages[0].pageTimings).toEqual({ onContentLoad: -1, onLoad: -1 });
      collector.stop();
    });

    it('should include required HAR entry fields', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      simulateResponse(client);
      await new Promise(r => setTimeout(r, 50));
      const har = collector.export('har') as any;
      const e = har.log.entries[0];
      expect(e.request.httpVersion).toBe('HTTP/1.1');
      expect(e.request.cookies).toEqual([]);
      expect(e.response.httpVersion).toBe('HTTP/1.1');
      expect(e.response.redirectURL).toBe('');
      expect(e.timings).toBeDefined();
      expect(e.pageref).toBe('page_0');
      collector.stop();
    });

    it('should export JSON format without log wrapper', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      const json = collector.export('json') as any;
      expect(json.entries).toBeDefined();
      expect(json.pages).toBeDefined();
      expect(json.log).toBeUndefined();
      collector.stop();
    });

    it('should handle multiple entries', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client, { requestId: 'r1' });
      simulateRequest(client, { requestId: 'r2' });
      simulateRequest(client, { requestId: 'r3' });
      expect(collector.getEntryCount()).toBe(3);
      expect((collector.export('har') as any).log.entries).toHaveLength(3);
      collector.stop();
    });

    it('should handle entry with no response', async () => {
      const collector = new HarCollector(client as any);
      await collector.start();
      simulateRequest(client);
      const har = collector.export('har') as any;
      expect(har.log.entries[0].response.status).toBe(0);
      expect(har.log.entries[0].time).toBe(0);
      collector.stop();
    });
  });
});
