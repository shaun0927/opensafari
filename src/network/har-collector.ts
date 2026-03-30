/**
 * HAR 1.2 Collector
 *
 * Captures network traffic from WebKit Remote Debugging Protocol events
 * and exports in HAR (HTTP Archive) 1.2 format.
 *
 * Uses Network.requestWillBeSent and Network.responseReceived events
 * from the WebKit inspector protocol.
 */

import { WebKitClient } from '../webkit/client';

// ---------------------------------------------------------------------------
// HAR 1.2 types (minimal subset for export)
// ---------------------------------------------------------------------------

interface HarHeader {
  name: string;
  value: string;
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarHeader[];
  headersSize: number;
  bodySize: number;
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  content: {
    size: number;
    mimeType: string;
    text?: string;
  };
  headersSize: number;
  bodySize: number;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

interface HarLog {
  version: string;
  creator: {
    name: string;
    version: string;
  };
  entries: HarEntry[];
}

interface HarDocument {
  log: HarLog;
}

// ---------------------------------------------------------------------------
// Internal tracking types
// ---------------------------------------------------------------------------

interface PendingRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
}

interface CompletedEntry {
  request: PendingRequest;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  mimeType: string;
  responseSize: number;
  endTimestamp: number;
  body?: string;
}

// ---------------------------------------------------------------------------
// Collector options
// ---------------------------------------------------------------------------

export interface HarCollectorOptions {
  /** Capture response bodies for text/JSON responses */
  captureBody?: boolean;
  /** Max response body size in bytes (default: 1MB) */
  maxBodySize?: number;
}

const DEFAULT_MAX_BODY_SIZE = 1048576; // 1MB

// ---------------------------------------------------------------------------
// HarCollector
// ---------------------------------------------------------------------------

export class HarCollector {
  private client: WebKitClient;
  private captureBody: boolean;
  private maxBodySize: number;
  private recording = false;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private entries: CompletedEntry[] = [];

  private onRequestHandler: (params: any) => void;
  private onResponseHandler: (params: any) => void;

  constructor(client: WebKitClient, options?: HarCollectorOptions) {
    this.client = client;
    this.captureBody = options?.captureBody ?? false;
    this.maxBodySize = options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;

    // Bind event handlers so they can be removed later
    this.onRequestHandler = (params: any) => this.handleRequest(params);
    this.onResponseHandler = (params: any) => this.handleResponse(params);
  }

  /**
   * Start capturing network traffic.
   * Enables the Network domain and attaches event listeners.
   */
  async start(): Promise<void> {
    if (this.recording) return;

    this.pendingRequests.clear();
    this.entries = [];

    // Enable Network domain for event delivery
    await this.client.send('Network.enable');

    this.client.on('Network.requestWillBeSent', this.onRequestHandler);
    this.client.on('Network.responseReceived', this.onResponseHandler);

    this.recording = true;
  }

  /**
   * Stop capturing network traffic.
   * Removes event listeners but preserves collected data for export.
   */
  stop(): void {
    if (!this.recording) return;

    this.client.removeListener('Network.requestWillBeSent', this.onRequestHandler);
    this.client.removeListener('Network.responseReceived', this.onResponseHandler);

    this.recording = false;
  }

  /** Whether the collector is currently recording. */
  isRecording(): boolean {
    return this.recording;
  }

  /** Number of completed entries captured so far. */
  getEntryCount(): number {
    return this.entries.length;
  }

  /**
   * Export captured data.
   * @param format - 'har' for full HAR 1.2 document, 'json' for raw entries array
   */
  export(format: 'har' | 'json' = 'har'): HarDocument | CompletedEntry[] {
    if (format === 'json') {
      return [...this.entries];
    }
    return this.buildHarDocument();
  }

  // ---------------------------------------------------------------------------
  // Private: event handlers
  // ---------------------------------------------------------------------------

  private handleRequest(params: any): void {
    const requestId = params.requestId as string | undefined;
    if (!requestId) return;

    const req = params.request ?? {};
    this.pendingRequests.set(requestId, {
      requestId,
      url: (req.url as string) ?? '',
      method: (req.method as string) ?? 'GET',
      headers: (req.headers as Record<string, string>) ?? {},
      timestamp: (params.timestamp as number) ?? Date.now() / 1000,
    });
  }

  private handleResponse(params: any): void {
    const requestId = params.requestId as string | undefined;
    if (!requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);

    const resp = params.response ?? {};
    const entry: CompletedEntry = {
      request: pending,
      status: (resp.status as number) ?? 0,
      statusText: (resp.statusText as string) ?? '',
      responseHeaders: (resp.headers as Record<string, string>) ?? {},
      mimeType: (resp.mimeType as string) ?? 'application/octet-stream',
      responseSize: (resp.encodedDataLength as number) ?? 0,
      endTimestamp: (params.timestamp as number) ?? Date.now() / 1000,
    };

    // Optionally capture response body for text-based responses
    if (this.captureBody && this.isTextMimeType(entry.mimeType)) {
      this.fetchResponseBody(requestId, entry);
    }

    this.entries.push(entry);
  }

  private isTextMimeType(mimeType: string): boolean {
    return (
      mimeType.startsWith('text/') ||
      mimeType.includes('json') ||
      mimeType.includes('xml') ||
      mimeType.includes('javascript') ||
      mimeType.includes('html') ||
      mimeType.includes('css')
    );
  }

  private fetchResponseBody(requestId: string, entry: CompletedEntry): void {
    this.client
      .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId })
      .then((result) => {
        const body = result.body ?? '';
        if (body.length <= this.maxBodySize) {
          entry.body = body;
        }
      })
      .catch(() => {
        // Response body may not be available; ignore errors
      });
  }

  // ---------------------------------------------------------------------------
  // Private: HAR document builder
  // ---------------------------------------------------------------------------

  private buildHarDocument(): HarDocument {
    const harEntries: HarEntry[] = this.entries.map((e) => {
      const elapsed = Math.max(0, (e.endTimestamp - e.request.timestamp) * 1000);

      return {
        startedDateTime: new Date(e.request.timestamp * 1000).toISOString(),
        time: elapsed,
        request: this.buildHarRequest(e),
        response: this.buildHarResponse(e),
        cache: {},
        timings: {
          send: 0,
          wait: elapsed,
          receive: 0,
        },
      };
    });

    return {
      log: {
        version: '1.2',
        creator: {
          name: 'OpenSafari',
          version: '0.1.0',
        },
        entries: harEntries,
      },
    };
  }

  private buildHarRequest(entry: CompletedEntry): HarRequest {
    const headers = this.headersToHar(entry.request.headers);
    const url = entry.request.url;
    const queryString = this.parseQueryString(url);

    return {
      method: entry.request.method,
      url,
      httpVersion: 'HTTP/1.1',
      headers,
      queryString,
      headersSize: -1,
      bodySize: 0,
    };
  }

  private buildHarResponse(entry: CompletedEntry): HarResponse {
    const headers = this.headersToHar(entry.responseHeaders);

    return {
      status: entry.status,
      statusText: entry.statusText,
      httpVersion: 'HTTP/1.1',
      headers,
      content: {
        size: entry.responseSize,
        mimeType: entry.mimeType,
        ...(entry.body !== undefined ? { text: entry.body } : {}),
      },
      headersSize: -1,
      bodySize: entry.responseSize,
    };
  }

  private headersToHar(headers: Record<string, string>): HarHeader[] {
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
  }

  private parseQueryString(url: string): HarHeader[] {
    try {
      const parsed = new URL(url);
      const result: HarHeader[] = [];
      parsed.searchParams.forEach((value, name) => {
        result.push({ name, value });
      });
      return result;
    } catch {
      return [];
    }
  }
}
