/**
 * HAR (HTTP Archive) Collector
 *
 * Captures network traffic from WebKit Remote Debugging Protocol events
 * and exports in HAR 1.2 format. Optionally captures response bodies
 * for text-based content types.
 *
 * @see http://www.softwareishard.com/blog/har-12-spec/
 */

import { WebKitClient } from '../webkit/client';

export interface HarCollectorOptions {
  /** Whether to capture response bodies for text/JSON responses */
  captureBody?: boolean;
  /** Maximum response body size in bytes (default: 1MB). Bodies exceeding this are skipped. */
  maxBodySize?: number;
  /**
   * Maximum number of stored entries (default: 2000). Requests beyond the cap
   * are counted as dropped instead of stored, so a long recording on a chatty
   * page cannot grow without bound. Existing entries are never evicted — HAR
   * consumers expect a stable prefix with intact request/response pairing.
   */
  maxEntries?: number;
}

interface PendingRequest {
  requestId: string;
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  queryString: Array<{ name: string; value: string }>;
  postData?: { mimeType: string; text: string };
  bodySize: number;
  startTime: number;
}

interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Array<{ name: string; value: string }>;
  mimeType: string;
  bodySize: number;
  content?: string;
  receivedTime: number;
}

interface NetworkEntry {
  request: PendingRequest;
  response?: CapturedResponse;
}

export class HarCollector {
  private entries: Map<string, NetworkEntry> = new Map();
  private pages: Array<{ id: string; title: string; startedDateTime: string }> = [];
  private recording = false;
  private client: WebKitClient;
  private captureBody: boolean;
  private maxBodySize: number;
  private maxEntries: number;
  private droppedEntries = 0;
  private requestListener: ((params: any) => void) | null = null;
  private responseListener: ((params: any) => void) | null = null;
  private startTime = 0;

  constructor(client: WebKitClient, options?: HarCollectorOptions) {
    this.client = client;
    this.captureBody = options?.captureBody ?? false;
    this.maxBodySize = options?.maxBodySize ?? 1024 * 1024; // 1MB
    this.maxEntries = options?.maxEntries ?? 2000;
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.recording = true;
    this.startTime = Date.now();
    this.entries.clear();
    this.droppedEntries = 0;
    this.pages = [{
      id: 'page_0',
      title: 'Page',
      startedDateTime: new Date(this.startTime).toISOString(),
    }];

    await this.client.enableDomain('Network');

    this.requestListener = (params: any) => {
      if (!this.recording) return;
      const req = params.request;
      if (!req) return;
      const requestId = params.requestId;

      if (this.entries.size >= this.maxEntries) {
        this.droppedEntries++;
        return;
      }

      const queryString: Array<{ name: string; value: string }> = [];
      try {
        const url = new URL(req.url);
        url.searchParams.forEach((value: string, name: string) => queryString.push({ name, value }));
      } catch { /* invalid URL -- skip query parsing */ }

      const headers: Array<{ name: string; value: string }> = [];
      if (req.headers && typeof req.headers === 'object') {
        for (const [name, value] of Object.entries(req.headers)) {
          headers.push({ name, value: String(value) });
        }
      }

      const postData = req.postData
        ? { mimeType: req.headers?.['Content-Type'] ?? req.headers?.['content-type'] ?? '', text: req.postData }
        : undefined;

      this.entries.set(requestId, {
        request: {
          requestId,
          method: req.method ?? 'GET',
          url: req.url ?? '',
          headers,
          queryString,
          postData,
          bodySize: req.postData ? req.postData.length : 0,
          startTime: params.timestamp ? params.timestamp * 1000 : Date.now(),
        },
      });
    };

    this.responseListener = async (params: any) => {
      if (!this.recording) return;
      const resp = params.response;
      if (!resp) return;
      const requestId = params.requestId;
      const entry = this.entries.get(requestId);
      if (!entry) return;

      const headers: Array<{ name: string; value: string }> = [];
      if (resp.headers && typeof resp.headers === 'object') {
        for (const [name, value] of Object.entries(resp.headers)) {
          headers.push({ name, value: String(value) });
        }
      }

      const mimeType = resp.mimeType ?? '';
      const receivedTime = params.timestamp ? params.timestamp * 1000 : Date.now();

      entry.response = {
        status: resp.status ?? 0,
        statusText: resp.statusText ?? '',
        headers,
        mimeType,
        bodySize: resp.encodedDataLength ?? -1,
        receivedTime,
      };

      if (this.captureBody && /^(text\/|application\/json)/.test(mimeType)) {
        // Skip the RPC entirely when the response is already known to exceed
        // the cap — fetching first and checking later would transfer the full
        // body over the protocol just to throw it away.
        const knownSize = resp.encodedDataLength;
        if (typeof knownSize === 'number' && knownSize > this.maxBodySize) {
          return;
        }
        try {
          const result = await this.client.send<{ body: string; base64Encoded?: boolean }>(
            'Network.getResponseBody',
            { requestId },
          );
          const body = result?.body ?? '';
          if (body.length <= this.maxBodySize) {
            entry.response.content = body;
          }
        } catch {
          // Body may be unavailable (redirects, cached responses, etc.)
        }
      }
    };

    this.client.on('Network.requestWillBeSent', this.requestListener);
    this.client.on('Network.responseReceived', this.responseListener);
  }

  stop(): void {
    this.recording = false;
    if (this.droppedEntries > 0) {
      console.error(
        `[HarCollector] Dropped ${this.droppedEntries} request(s) beyond maxEntries=${this.maxEntries}; ` +
        `raise the maxEntries option to record more`,
      );
    }
    if (this.requestListener) {
      this.client.removeListener('Network.requestWillBeSent', this.requestListener);
      this.requestListener = null;
    }
    if (this.responseListener) {
      this.client.removeListener('Network.responseReceived', this.responseListener);
      this.responseListener = null;
    }
  }

  export(format: 'har' | 'json' = 'har'): object {
    const harEntries = Array.from(this.entries.values()).map(entry => {
      const startedDateTime = new Date(entry.request.startTime).toISOString();
      const waitTime = entry.response
        ? entry.response.receivedTime - entry.request.startTime
        : -1;

      const harEntry: Record<string, unknown> = {
        startedDateTime,
        time: waitTime > 0 ? waitTime : 0,
        request: {
          method: entry.request.method,
          url: entry.request.url,
          httpVersion: 'HTTP/1.1',
          headers: entry.request.headers,
          queryString: entry.request.queryString,
          cookies: [],
          headersSize: -1,
          bodySize: entry.request.bodySize,
          ...(entry.request.postData ? { postData: entry.request.postData } : {}),
        },
        response: {
          status: entry.response?.status ?? 0,
          statusText: entry.response?.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: entry.response?.headers ?? [],
          cookies: [],
          content: {
            size: entry.response?.bodySize ?? -1,
            mimeType: entry.response?.mimeType ?? '',
            ...(entry.response?.content !== undefined ? { text: entry.response.content } : {}),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: entry.response?.bodySize ?? -1,
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: 0,
          wait: waitTime > 0 ? waitTime : -1,
          receive: 0,
        },
        pageref: this.pages.length > 0 ? this.pages[this.pages.length - 1].id : undefined,
      };

      return harEntry;
    });

    if (format === 'json') {
      return { entries: harEntries, pages: this.pages };
    }

    return {
      log: {
        version: '1.2',
        creator: { name: 'opensafari', version: '0.1.1' },
        pages: this.pages.map(p => ({
          startedDateTime: p.startedDateTime,
          id: p.id,
          title: p.title,
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        })),
        entries: harEntries,
      },
    };
  }

  isRecording(): boolean {
    return this.recording;
  }

  getEntryCount(): number {
    return this.entries.size;
  }

  /** Requests not stored because the maxEntries cap was reached. */
  getDroppedCount(): number {
    return this.droppedEntries;
  }

  clear(): void {
    this.entries.clear();
    this.pages = [];
  }
}
