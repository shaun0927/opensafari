/**
 * Runtime schema validator for MCP tool registration.
 * Warns about patterns incompatible with various AI APIs (Gemini, OpenAI, etc.).
 * Does NOT throw — only logs warnings via console.error.
 */
import { MCPToolDefinition } from '../types/mcp';
/**
 * Validate a tool's input schema for cross-API compatibility.
 * Logs warnings via console.error. Does NOT throw.
 */
export declare function validateToolSchema(name: string, schema: MCPToolDefinition['inputSchema']): void;
//# sourceMappingURL=schema-validator.d.ts.map