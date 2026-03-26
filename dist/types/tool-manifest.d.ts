/**
 * Tool Manifest Types - Shared Tool Registry for worker agents
 *
 * Enables workflow_init to export registered tool schemas so that
 * worker agents can skip ToolSearch and call tools immediately.
 */
/** A single tool entry in the manifest */
export interface ToolEntry {
    /** Full MCP tool name (e.g. "navigate", "javascript_tool") */
    name: string;
    /** Human-readable description */
    description: string;
    /** JSON Schema for tool parameters */
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    /** Tool category for filtering */
    category: ToolCategory;
}
/** Tool categories for WorkerToolConfig filtering */
export type ToolCategory = 'navigation' | 'interaction' | 'content' | 'javascript' | 'network' | 'tabs' | 'media' | 'emulation' | 'orchestration' | 'worker' | 'composite' | 'performance' | 'lifecycle';
/** The complete tool manifest exported by the MCP server */
export interface ToolManifest {
    /** Manifest version for cache invalidation */
    version: string;
    /** Generation timestamp */
    generatedAt: number;
    /** All registered tools */
    tools: ToolEntry[];
    /** Total tool count */
    toolCount: number;
}
/** Per-worker tool access configuration */
export interface WorkerToolConfig {
    /** Worker type determines default tool set */
    workerType: 'extraction' | 'interaction' | 'full';
    /** Allowed tool categories (whitelist) */
    allowedCategories?: ToolCategory[];
    /** Specific tools to include regardless of category */
    additionalTools?: string[];
    /** Specific tools to exclude regardless of category */
    excludedTools?: string[];
}
/** Default tool sets per worker type */
export declare const DEFAULT_WORKER_TOOLS: Record<WorkerToolConfig['workerType'], ToolCategory[]>;
/**
 * Filter manifest tools based on WorkerToolConfig
 */
export declare function filterToolsForWorker(manifest: ToolManifest, config: WorkerToolConfig): ToolEntry[];
//# sourceMappingURL=tool-manifest.d.ts.map