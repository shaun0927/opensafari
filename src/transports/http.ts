/**
 * Streamable HTTP transport for MCP server.
 *
 * Implements MCP Streamable HTTP transport (spec 2025-03-26):
 * - POST /mcp: receives JSON-RPC request/notification, returns JSON-RPC response
 * - GET /health: basic health check (separate from the self-healing health endpoint)
 * - DELETE /mcp: session termination
 *
 * Key difference from stdio: client disconnect does NOT kill the server.
 * The HTTP server continues to accept new connections.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MCPResponse, MCPErrorCodes } from '../types/mcp';
import { MCPTransport } from './index';
import type { TransportOptions } from './index';

/** Maximum allowed HTTP request body size (10 MB) to prevent OOM from oversized requests */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_HTTP_HOST = '127.0.0.1';

/** Active SSE connections for server-initiated notifications */
interface SSEConnection {
  res: http.ServerResponse;
  sessionId: string;
}

function logTransportEvent(event: string, details: Record<string, unknown>): void {
  console.error(`[HTTPTransport] ${JSON.stringify({ event, ...details })}`);
}

export class HTTPTransport implements MCPTransport {
  private server: http.Server | null = null;
  private messageHandler: ((msg: Record<string, unknown>) => Promise<MCPResponse | null>) | null = null;
  private port: number;
  private host: string;
  private authToken?: string;
  private insecure: boolean;
  private allowedOrigins: Set<string>;
  private sessions: Set<string> = new Set();
  private sseConnections: SSEConnection[] = [];
  private sessionDeleteHandler: ((sessionId: string) => void) | null = null;

  constructor(port: number, options: TransportOptions = {}) {
    this.port = port;
    this.host = options.host || DEFAULT_HTTP_HOST;
    this.authToken = options.authToken || process.env.OPENSAFARI_HTTP_TOKEN;
    this.insecure = options.insecure === true;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
  }

  /**
   * Register a callback to be invoked whenever a session is deleted.
   * Used by MCPServer to clean up per-session state (e.g. rate-limiter buckets).
   */
  onSessionDelete(handler: (sessionId: string) => void): void {
    this.sessionDeleteHandler = handler;
  }

  onMessage(handler: (msg: Record<string, unknown>) => Promise<MCPResponse | null>): void {
    this.messageHandler = handler;
  }

  /**
   * Send a server-initiated notification to all connected SSE clients.
   * For HTTP, request-correlated responses are sent directly in handlePost.
   */
  send(response: MCPResponse): void {
    // Broadcast to all SSE connections
    for (const conn of this.sseConnections) {
      try {
        conn.res.write(`data: ${JSON.stringify(response)}\n\n`);
      } catch {
        // Connection may have been closed
      }
    }
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleHTTPRequest(req, res);
    });

    this.server.on('clientError', (err, socket) => {
      logTransportEvent('client_error', {
        port: this.port,
        message: err.message,
      });
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    });

    this.server.on('close', () => {
      logTransportEvent('server_closed', { port: this.port });
    });

    await new Promise<void>((resolve, reject) => {
      const startupError = (err: NodeJS.ErrnoException) => {
        this.server!.removeListener('listening', onListening);
        reject(err);
      };

      const onListening = () => {
        this.server!.removeListener('error', startupError);
        this.server!.on('error', (err) =>
          logTransportEvent('server_error', {
            port: this.port,
            message: err.message,
          }));
        console.error(`[HTTPTransport] Listening on ${this.host}:${this.port}`);
        console.error(`[HTTPTransport] MCP endpoint: http://${this.host}:${this.port}/mcp`);
        if (this.insecure) {
          console.error('[HTTPTransport] Warning: HTTP /mcp token auth is disabled by explicit insecure mode');
        } else if (!this.authToken) {
          console.error('[HTTPTransport] Warning: HTTP /mcp requires OPENSAFARI_HTTP_TOKEN or --http-token; requests will be rejected');
        }
        resolve();
      };

      this.server!.once('error', startupError);
      this.server!.once('listening', onListening);
      this.server!.listen(this.port, this.host);
    });
  }

  getAddress(): AddressInfo | string | null {
    return this.server?.address() ?? null;
  }

  async close(): Promise<void> {
    // Close all SSE connections
    for (const conn of this.sseConnections) {
      try {
        conn.res.end();
      } catch {
        // Already closed
      }
    }
    this.sseConnections = [];

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleHTTPRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    const corsAllowed = this.applyCorsHeaders(req, res, pathname);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      if (pathname === '/mcp' && !corsAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health') {
      this.handleHealth(res);
      return;
    }

    if (pathname === '/mcp') {
      if (!corsAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }

      if (!this.isAuthorized(req)) {
        this.writeUnauthorized(res);
        return;
      }

      switch (req.method) {
        case 'POST':
          this.handlePost(req, res);
          return;
        case 'GET':
          this.handleSSE(req, res);
          return;
        case 'DELETE':
          this.handleDelete(req, res);
          return;
        default:
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
      }
    }

    // Unknown path
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private applyCorsHeaders(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): boolean {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    const originHeader = req.headers.origin;
    if (!originHeader || Array.isArray(originHeader)) {
      return true;
    }

    if (pathname === '/mcp' && !this.isAllowedOrigin(originHeader)) {
      return false;
    }

    if (this.isAllowedOrigin(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }

    return true;
  }

  private isAllowedOrigin(origin: string): boolean {
    if (this.allowedOrigins.has(origin)) {
      return true;
    }

    try {
      const url = new URL(origin);
      return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (this.insecure) {
      return true;
    }
    if (!this.authToken) {
      return false;
    }

    const auth = req.headers.authorization;
    return typeof auth === 'string' && auth === `Bearer ${this.authToken}`;
  }

  private writeUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      error: {
        code: MCPErrorCodes.INVALID_REQUEST,
        message: 'Unauthorized',
      },
    }));
  }

  /**
   * GET /health - basic health check
   */
  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      transport: 'http',
      activeSessions: this.sessions.size,
      sseConnections: this.sseConnections.length,
    }));
  }

  /**
   * POST /mcp - handle JSON-RPC request or batch
   */
  private handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;

    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.INVALID_REQUEST, message: 'Request body too large' },
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');

      if (!body.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.PARSE_ERROR, message: 'Empty request body' },
        }));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: MCPErrorCodes.PARSE_ERROR,
            message: error instanceof Error ? error.message : 'Parse error',
          },
        }));
        return;
      }

      // Session tracking via Mcp-Session-Id header
      let sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!this.messageHandler) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.INTERNAL_ERROR, message: 'No message handler registered' },
        }));
        return;
      }

      // Handle JSON-RPC batch (array of requests)
      if (Array.isArray(parsed)) {
        const results = await this.processBatch(parsed, sessionId);
        // Filter out null results (notifications don't produce responses)
        const responses = results.filter((r): r is MCPResponse => r !== null);

        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }

        if (responses.length === 0) {
          // All were notifications — respond with 202 Accepted
          res.writeHead(202);
          res.end();
        } else if (responses.length === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responses[0]));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responses));
        }
        return;
      }

      // Single request/notification
      const msg = parsed as Record<string, unknown>;

      // Check if this is an initialize request — assign session ID
      if (msg.method === 'initialize' && !sessionId) {
        sessionId = crypto.randomUUID();
        this.sessions.add(sessionId);
      }

      try {
        const response = await this.messageHandler(msg);

        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }

        if (response === null) {
          // Notification — no response body
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        }
      } catch (error) {
        const id = (msg.id as string | number) ?? 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        }));
      }
    });

    req.on('error', (err) => {
      logTransportEvent('request_read_error', {
        port: this.port,
        message: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.PARSE_ERROR, message: 'Request read error' },
        }));
      }
    });
  }

  /**
   * GET /mcp - Server-Sent Events for server-initiated notifications
   */
  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'] as string || 'anonymous';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial keepalive
    res.write(': keepalive\n\n');

    const conn: SSEConnection = { res, sessionId };
    this.sseConnections.push(conn);

    // Clean up on disconnect
    req.on('close', () => {
      const idx = this.sseConnections.indexOf(conn);
      if (idx !== -1) {
        this.sseConnections.splice(idx, 1);
      }
      console.error(`[HTTPTransport] SSE client disconnected (session: ${sessionId})`);
    });
  }

  /**
   * DELETE /mcp - Session termination
   */
  private handleDelete(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);

      // Notify session-delete listeners (e.g. rate-limiter cleanup)
      if (this.sessionDeleteHandler) {
        this.sessionDeleteHandler(sessionId);
      }

      // Close any SSE connections for this session
      this.sseConnections = this.sseConnections.filter((conn) => {
        if (conn.sessionId === sessionId) {
          try {
            conn.res.end();
          } catch {
            // Already closed
          }
          return false;
        }
        return true;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'session terminated' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
  }

  /**
   * Process a batch of JSON-RPC messages
   */
  private async processBatch(
    messages: unknown[],
    sessionId: string | undefined,
  ): Promise<(MCPResponse | null)[]> {
    const handler = this.messageHandler!;

    // Assign sessionId once before concurrent processing to avoid data race
    // when multiple initialize requests appear in the same batch.
    if (!sessionId) {
      const hasInitialize = messages.some(
        (msg) => typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).method === 'initialize',
      );
      if (hasInitialize) {
        sessionId = crypto.randomUUID();
        this.sessions.add(sessionId);
      }
    }

    const promises = messages.map(async (msg) => {
      if (typeof msg !== 'object' || msg === null) {
        return {
          jsonrpc: '2.0' as const,
          id: 0,
          error: {
            code: MCPErrorCodes.INVALID_REQUEST,
            message: 'Invalid batch element: not an object',
          },
        } as MCPResponse;
      }

      const record = msg as Record<string, unknown>;

      try {
        return await handler(record);
      } catch (error) {
        const id = (record.id as string | number) ?? 0;
        return {
          jsonrpc: '2.0' as const,
          id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        } as MCPResponse;
      }
    });

    return Promise.all(promises);
  }
}
