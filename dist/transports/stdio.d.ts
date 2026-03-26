/**
 * Stdio transport for MCP server.
 * Reads JSON-RPC messages from stdin (one per line), writes responses to stdout.
 * When stdin closes (EOF), the process exits — this is the expected stdio lifecycle.
 */
import { MCPResponse } from '../types/mcp';
import { MCPTransport } from './index';
export declare class StdioTransport implements MCPTransport {
    private rl;
    private messageHandler;
    onMessage(handler: (msg: Record<string, unknown>) => Promise<MCPResponse | null>): void;
    send(response: MCPResponse): void;
    start(): void;
    close(): Promise<void>;
}
//# sourceMappingURL=stdio.d.ts.map