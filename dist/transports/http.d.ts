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
import { MCPResponse } from '../types/mcp';
import { MCPTransport } from './index';
export declare class HTTPTransport implements MCPTransport {
    private server;
    private messageHandler;
    private port;
    private sessions;
    private sseConnections;
    private sessionDeleteHandler;
    constructor(port: number);
    /**
     * Register a callback to be invoked whenever a session is deleted.
     * Used by MCPServer to clean up per-session state (e.g. rate-limiter buckets).
     */
    onSessionDelete(handler: (sessionId: string) => void): void;
    onMessage(handler: (msg: Record<string, unknown>) => Promise<MCPResponse | null>): void;
    /**
     * Send a server-initiated notification to all connected SSE clients.
     * For HTTP, request-correlated responses are sent directly in handlePost.
     */
    send(response: MCPResponse): void;
    start(): void;
    close(): Promise<void>;
    private handleHTTPRequest;
    /**
     * GET /health - basic health check
     */
    private handleHealth;
    /**
     * POST /mcp - handle JSON-RPC request or batch
     */
    private handlePost;
    /**
     * GET /mcp - Server-Sent Events for server-initiated notifications
     */
    private handleSSE;
    /**
     * DELETE /mcp - Session termination
     */
    private handleDelete;
    /**
     * Process a batch of JSON-RPC messages
     */
    private processBatch;
}
//# sourceMappingURL=http.d.ts.map