/**
 * flutter_network — HTTP traffic capture for native/Flutter apps.
 *
 * Starts a local HTTP proxy, configures the simulator to route traffic
 * through it, and captures request/response metadata. Provides log
 * retrieval and HAR export.
 */

import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';

interface NetworkEntry {
  id: number;
  timestamp: number;
  method: string;
  url: string;
  statusCode?: number;
  requestHeaders: Record<string, string | string[] | undefined>;
  responseHeaders?: Record<string, string | string[] | undefined>;
  requestSize: number;
  responseSize: number;
  duration?: number;
  error?: string;
}

interface ProxyState {
  server: http.Server;
  port: number;
  entries: NetworkEntry[];
  entryId: number;
  deviceId: string;
  throttleMs: number;
}

// Per-device proxy state
const proxies = new Map<string, ProxyState>();
const MAX_ENTRIES = 1000;

export function registerFlutterNetworkTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_network',
      description:
        'Capture HTTP network traffic from Flutter/native apps via a local proxy. ' +
        'Actions: "start" begins capture, "log" returns captured requests, ' +
        '"har" exports as HAR format, "stop" stops capture and cleans up, ' +
        '"throttle" updates the response delay.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'log', 'har', 'stop', 'throttle'],
            description: 'Action to perform (default: "log")',
          },
          port: {
            type: 'number',
            description: 'Proxy port (default: 8888). Only used with "start" action.',
          },
          filter_url: {
            type: 'string',
            description: 'Filter entries by URL substring',
          },
          filter_status: {
            type: 'number',
            description: 'Filter entries by HTTP status code',
          },
          limit: {
            type: 'number',
            description: 'Max entries to return (default: 50)',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          throttle_ms: {
            type: 'number',
            description: 'Delay each proxied response by this many milliseconds (default: 0 = no delay). Settable at start and updatable via action "throttle".',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }

        const action = (params.action as string | undefined) ?? 'log';

        switch (action) {
          case 'start':
            return await handleStart(deviceId, params);
          case 'log':
            return handleLog(deviceId, params);
          case 'har':
            return handleHar(deviceId);
          case 'stop':
            return await handleStop(deviceId);
          case 'throttle':
            return handleThrottle(deviceId, params);
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_network] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

async function handleStart(
  deviceId: string,
  params: Record<string, unknown>,
) {
  if (proxies.has(deviceId)) {
    throw new Error('Proxy already running for this device. Stop it first with action "stop".');
  }

  const port = (params.port as number | undefined) ?? 8888;
  const throttleMs = (params.throttle_ms as number | undefined) ?? 0;
  if (!isFinite(throttleMs) || throttleMs < 0) {
    throw new Error('throttle_ms must be a non-negative finite number.');
  }

  // Create HTTP proxy server
  const proxyServer = http.createServer((clientReq, clientRes) => {
    const state = proxies.get(deviceId);
    if (!state) return;

    const reqUrl = clientReq.url ?? '/';
    const entry: NetworkEntry = {
      id: ++state.entryId,
      timestamp: Date.now(),
      method: clientReq.method ?? 'GET',
      url: reqUrl,
      requestHeaders: clientReq.headers as Record<string, string | string[] | undefined>,
      requestSize: 0,
      responseSize: 0,
    };

    // Track request size
    clientReq.on('data', (chunk: Buffer) => {
      entry.requestSize += chunk.length;
    });

    // Forward request
    try {
      const parsed = url.parse(reqUrl);
      const isHttps = parsed.protocol === 'https:';
      const requestModule = isHttps ? https : http;

      const proxyReq = requestModule.request(
        {
          hostname: parsed.hostname,
          port: parsed.port ?? (isHttps ? 443 : 80),
          path: parsed.path,
          method: clientReq.method,
          headers: clientReq.headers,
        },
        (proxyRes) => {
          entry.statusCode = proxyRes.statusCode;
          entry.responseHeaders = proxyRes.headers as Record<string, string | string[] | undefined>;
          entry.duration = Date.now() - entry.timestamp;

          proxyRes.on('data', (chunk: Buffer) => {
            entry.responseSize += chunk.length;
          });

          proxyRes.on('end', () => {
            addEntry(state, entry);
          });

          proxyRes.pause();
          const sendResponse = () => {
            clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(clientRes, { end: true });
          };
          if (state.throttleMs > 0) {
            setTimeout(sendResponse, state.throttleMs);
          } else {
            sendResponse();
          }
        },
      );

      proxyReq.on('error', (err) => {
        entry.error = err.message;
        entry.duration = Date.now() - entry.timestamp;
        addEntry(state, entry);
        clientRes.writeHead(502);
        clientRes.end('Proxy Error');
      });

      clientReq.pipe(proxyReq, { end: true });
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      addEntry(state, entry);
      clientRes.writeHead(502);
      clientRes.end('Proxy Error');
    }
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    proxyServer.on('error', (err) => {
      reject(new Error(`Could not start proxy on port ${port}: ${err.message}`));
    });
    proxyServer.listen(port, '127.0.0.1', () => resolve());
  });

  proxies.set(deviceId, {
    server: proxyServer,
    port,
    entries: [],
    entryId: 0,
    deviceId,
    throttleMs,
  });

  // Configure simulator to use proxy
  const simctl = new SimctlExecutor();
  try {
    await simctl.exec([
      'spawn', deviceId, 'defaults', 'write',
      'Apple Global Domain', 'WebKitProxyDefaultsKey',
      '-dict', 'HTTPEnable', '-int', '1',
      'HTTPProxy', '-string', '127.0.0.1',
      'HTTPPort', '-int', String(port),
    ]);
  } catch {
    // Proxy config may not work on all simulator versions — capture still works for explicit proxy clients
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'started',
        port,
        deviceId,
        throttle_ms: throttleMs,
        message: `HTTP proxy listening on 127.0.0.1:${port}. Configure your Flutter app to use this proxy or set NSGlobalDomain proxy settings.`,
      }),
    }],
  };
}

function handleLog(
  deviceId: string,
  params: Record<string, unknown>,
) {
  const state = proxies.get(deviceId);
  if (!state) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'No proxy running for this device. Start one with action "start".',
        }),
      }],
    };
  }

  let entries = [...state.entries];

  const filterUrl = params.filter_url as string | undefined;
  if (filterUrl) {
    entries = entries.filter((e) =>
      e.url.toLowerCase().includes(filterUrl.toLowerCase()),
    );
  }

  const filterStatus = params.filter_status as number | undefined;
  if (filterStatus) {
    entries = entries.filter((e) => e.statusCode === filterStatus);
  }

  const limit = (params.limit as number | undefined) ?? 50;
  const limited = entries.slice(-limit);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        total: state.entries.length,
        filtered: entries.length,
        returned: limited.length,
        entries: limited.map((e) => ({
          id: e.id,
          time: new Date(e.timestamp).toISOString(),
          method: e.method,
          url: e.url,
          status: e.statusCode,
          duration_ms: e.duration,
          request_size: e.requestSize,
          response_size: e.responseSize,
          error: e.error,
        })),
      }, null, 2),
    }],
  };
}

function handleHar(
  deviceId: string,
) {
  const state = proxies.get(deviceId);
  if (!state) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'No proxy running.' }),
      }],
    };
  }

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'opensafari', version: '0.2.9' },
      entries: state.entries.map((e) => ({
        startedDateTime: new Date(e.timestamp).toISOString(),
        time: e.duration ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(e.requestHeaders ?? {}).map(([k, v]) => ({
            name: k,
            value: String(v),
          })),
          headersSize: -1,
          bodySize: e.requestSize,
        },
        response: {
          status: e.statusCode ?? 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(e.responseHeaders ?? {}).map(([k, v]) => ({
            name: k,
            value: String(v),
          })),
          content: { size: e.responseSize, mimeType: '' },
          headersSize: -1,
          bodySize: e.responseSize,
        },
        cache: {},
        timings: {
          send: 0,
          wait: e.duration ?? 0,
          receive: 0,
        },
      })),
    },
  };

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(har, null, 2),
    }],
  };
}

async function handleStop(
  deviceId: string,
) {
  const state = proxies.get(deviceId);
  if (!state) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'not_running', message: 'No proxy to stop.' }),
      }],
    };
  }

  const entriesCount = state.entries.length;

  // Close server
  await new Promise<void>((resolve) => {
    state.server.close(() => resolve());
  });

  // Clear simulator proxy settings
  const simctl = new SimctlExecutor();
  try {
    await simctl.exec([
      'spawn', deviceId, 'defaults', 'delete',
      'Apple Global Domain', 'WebKitProxyDefaultsKey',
    ]);
  } catch {
    // Ignore cleanup errors
  }

  proxies.delete(deviceId);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'stopped',
        deviceId,
        entries_captured: entriesCount,
      }),
    }],
  };
}

function handleThrottle(
  deviceId: string,
  params: Record<string, unknown>,
) {
  const state = proxies.get(deviceId);
  if (!state) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'No proxy running for this device.' }),
      }],
    };
  }

  const throttleMs = (params.throttle_ms as number | undefined) ?? 0;
  if (!isFinite(throttleMs) || throttleMs < 0) {
    throw new Error('throttle_ms must be a non-negative finite number.');
  }

  state.throttleMs = throttleMs;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'updated',
        deviceId,
        throttle_ms: throttleMs,
      }),
    }],
  };
}

function addEntry(state: ProxyState, entry: NetworkEntry): void {
  state.entries.push(entry);
  while (state.entries.length > MAX_ENTRIES) {
    state.entries.shift();
  }
}
