/**
 * Tests for WebKitClient.listTargets redirect resolution (Issue #648).
 *
 * Covers:
 * - All-inline input: no redirect HTTP call is issued.
 * - All-redirect input: every stub is expanded.
 * - Mixed input: redirect stubs are expanded, inline targets pass through.
 * - Mixed input with one failing redirect: that entry contributes [], others resolve.
 * - Empty input: returns [] with no redirect calls.
 */

import { WebKitClient } from '../../src/webkit/client';

type ClientPrivate = {
  httpGet: (url: string) => Promise<string>;
  listTargets: () => Promise<Array<{ id?: string; url?: string; webSocketDebuggerUrl?: string }>>;
};

function asPrivate(client: WebKitClient): ClientPrivate {
  return client as unknown as ClientPrivate;
}

describe('WebKitClient.listTargets redirect resolution', () => {
  let client: WebKitClient;

  beforeEach(() => {
    client = new WebKitClient({ host: 'localhost', port: 9221 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes through inline targets without issuing redirect requests', async () => {
    const inline = [
      {
        id: 'page-1',
        title: 'Inline A',
        url: 'https://example.com/a',
        webSocketDebuggerUrl: 'ws://localhost:9322/devtools/page/page-1',
      },
      {
        id: 'page-2',
        title: 'Inline B',
        url: 'https://example.com/b',
        webSocketDebuggerUrl: 'ws://localhost:9322/devtools/page/page-2',
      },
    ];

    const spy = jest
      .spyOn(asPrivate(client), 'httpGet')
      .mockResolvedValueOnce(JSON.stringify(inline));

    const targets = await client.listTargets();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('http://localhost:9221/json');
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id)).toEqual(['page-1', 'page-2']);
    expect(targets.every((t) => typeof t.webSocketDebuggerUrl === 'string')).toBe(true);
  });

  it('expands every redirect stub when the top-level /json is all redirects', async () => {
    const topLevel = [{ url: 'localhost:9322' }, { url: 'localhost:9323' }];
    const firstDevice = [
      {
        id: 'page-a',
        title: 'Device 1 page',
        url: 'https://a.example',
        webSocketDebuggerUrl: 'ws://localhost:9322/devtools/page/page-a',
      },
    ];
    const secondDevice = [
      {
        id: 'page-b',
        title: 'Device 2 page',
        url: 'https://b.example',
        webSocketDebuggerUrl: 'ws://localhost:9323/devtools/page/page-b',
      },
    ];

    const spy = jest
      .spyOn(asPrivate(client), 'httpGet')
      .mockImplementation(async (url: string) => {
        if (url === 'http://localhost:9221/json') return JSON.stringify(topLevel);
        if (url === 'http://localhost:9322/json') return JSON.stringify(firstDevice);
        if (url === 'http://localhost:9323/json') return JSON.stringify(secondDevice);
        throw new Error(`unexpected url ${url}`);
      });

    const targets = await client.listTargets();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(targets.map((t) => t.id)).toEqual(['page-a', 'page-b']);
    expect(targets.every((t) => typeof t.webSocketDebuggerUrl === 'string')).toBe(true);
  });

  it('resolves mixed redirect + inline entries per-entry, not all-or-nothing', async () => {
    const topLevel = [
      { url: 'localhost:9322' },
      {
        id: 'page-inline',
        title: 'Inline next to redirect',
        url: 'https://example.com',
        webSocketDebuggerUrl: 'ws://localhost:9322/devtools/page/page-inline',
      },
    ];
    const redirected = [
      {
        id: 'page-device',
        title: 'Inside redirect',
        url: 'https://device.example',
        webSocketDebuggerUrl: 'ws://localhost:9322/devtools/page/page-device',
      },
    ];

    const spy = jest
      .spyOn(asPrivate(client), 'httpGet')
      .mockImplementation(async (url: string) => {
        if (url === 'http://localhost:9221/json') return JSON.stringify(topLevel);
        if (url === 'http://localhost:9322/json') return JSON.stringify(redirected);
        throw new Error(`unexpected url ${url}`);
      });

    const targets = await client.listTargets();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id).sort()).toEqual(['page-device', 'page-inline']);
    // No redirect stub leaks to callers — every entry has a webSocketDebuggerUrl.
    expect(targets.every((t) => typeof t.webSocketDebuggerUrl === 'string')).toBe(true);
    expect(
      targets.some((t) => t.webSocketDebuggerUrl === undefined && t.url === 'localhost:9322'),
    ).toBe(false);
  });

  it('keeps other entries when one redirect fails to resolve', async () => {
    const topLevel = [
      { url: 'localhost:9322' }, // will fail
      { url: 'localhost:9323' }, // will succeed
      {
        id: 'page-inline',
        title: 'Inline survivor',
        url: 'https://example.com',
        webSocketDebuggerUrl: 'ws://localhost:9324/devtools/page/page-inline',
      },
    ];
    const secondDevice = [
      {
        id: 'page-ok',
        title: 'Resolved page',
        url: 'https://ok.example',
        webSocketDebuggerUrl: 'ws://localhost:9323/devtools/page/page-ok',
      },
    ];

    jest
      .spyOn(asPrivate(client), 'httpGet')
      .mockImplementation(async (url: string) => {
        if (url === 'http://localhost:9221/json') return JSON.stringify(topLevel);
        if (url === 'http://localhost:9322/json') throw new Error('ECONNREFUSED');
        if (url === 'http://localhost:9323/json') return JSON.stringify(secondDevice);
        throw new Error(`unexpected url ${url}`);
      });

    const targets = await client.listTargets();

    expect(targets.map((t) => t.id).sort()).toEqual(['page-inline', 'page-ok']);
    expect(targets.every((t) => typeof t.webSocketDebuggerUrl === 'string')).toBe(true);
  });

  it('returns [] for empty top-level /json without further requests', async () => {
    const spy = jest
      .spyOn(asPrivate(client), 'httpGet')
      .mockResolvedValueOnce('[]');

    const targets = await client.listTargets();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(targets).toEqual([]);
  });
});
