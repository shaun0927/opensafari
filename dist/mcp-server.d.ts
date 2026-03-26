/**
 * OpenSafari MCP Server
 * Handles JSON-RPC 2.0 protocol, tool registration, and progressive disclosure.
 * Safari-specific tools are registered externally via registerTool().
 *
 * Chrome/CDP references have been removed. Safari/WebKit/Simulator placeholders
 * are in place; actual implementations land in Epic 1B/1C.
 */
import { MCPToolDefinition, ToolHandler } from './types/mcp';
import { TransportMode } from './transports';
import { TOOL_TIERS, getToolTier } from './config/tool-tiers';
import { BrowserBackend } from './types/browser-backend';
export type { MCPToolDefinition as ToolDefinition, ToolHandler };
export { TOOL_TIERS, getToolTier };
export declare function getWebKitClient(): BrowserBackend | null;
export declare function setWebKitClient(client: BrowserBackend | null): void;
export interface MCPServerOptions {
    /** Wire transport to use. Defaults to 'stdio'. */
    transport?: TransportMode;
    /** HTTP port — only relevant when transport === 'http'. */
    port?: number;
}
export declare class MCPServer {
    private tools;
    private transport;
    private currentTier;
    registerTool(definition: MCPToolDefinition, handler: ToolHandler): void;
    getToolHandler(name: string): ToolHandler | undefined;
    getRegisteredTools(): string[];
    start(options?: MCPServerOptions): void;
    stop(): Promise<void>;
    setTier(tier: number): void;
    getTier(): number;
    private handleMessage;
    private handleInitialize;
    private handleToolsList;
    private handleToolsCall;
}
//# sourceMappingURL=mcp-server.d.ts.map