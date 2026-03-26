/**
 * MCP Protocol Types - Ported from extension
 */
export interface MCPRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
}
export interface MCPNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}
export interface MCPResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: MCPResult;
    error?: MCPError;
}
export interface MCPResult {
    [key: string]: unknown;
    content?: MCPContent[];
    isError?: boolean;
}
export interface MCPContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
}
export interface MCPError {
    code: number;
    message: string;
    data?: unknown;
}
export interface MCPToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}
export type ToolHandler = (sessionId: string, params: Record<string, unknown>) => Promise<MCPResult>;
export interface ToolRegistry {
    name: string;
    handler: ToolHandler;
    definition: MCPToolDefinition;
    /** When true, timeout errors return isError:false (tool produced useful partial state). */
    timeoutRecoverable?: boolean;
}
export declare const MCPErrorCodes: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
/** LLM-side override for compression level on individual tool calls */
export type CompressionOverride = 'none' | 'light' | 'aggressive';
//# sourceMappingURL=mcp.d.ts.map