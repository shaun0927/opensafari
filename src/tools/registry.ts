/**
 * Tool Registry — lazy-loading handler table for MCP tools.
 *
 * Schemas and tier metadata are statically available so tools/list can respond
 * without loading any handler module.  Handlers are imported dynamically the
 * first time a tool is invoked and cached for all subsequent calls.
 *
 * Usage:
 *   import { toolRegistry, defineToolEntry, resolveHandler } from './registry';
 *   defineToolEntry(definition, () => import('./my-tool').then(m => m.handler));
 */

import { MCPToolDefinition, ToolHandler } from '../types/mcp';
import { getToolTier } from '../config/tool-tiers';

// ---------------------------------------------------------------------------
// Registry entry shape
// ---------------------------------------------------------------------------

export interface LazyToolEntry {
  /** Static schema — used for tools/list without loading the handler. */
  definition: MCPToolDefinition;
  /** Tier derived from tool-tiers config. */
  tier: number;
  /**
   * Factory that dynamically imports the handler module.
   * Returns the ToolHandler directly (not the full module object) so the
   * registry remains decoupled from each module's export shape.
   */
  loadHandler: () => Promise<ToolHandler>;
  /** Resolved handler cache — populated on first invocation. */
  _cachedHandler?: ToolHandler;
  /** In-flight load promise — dedupes concurrent calls to loadHandler. */
  _loading?: Promise<ToolHandler>;
}

// ---------------------------------------------------------------------------
// Registry map — tool name → entry
// ---------------------------------------------------------------------------

export const toolRegistry: Map<string, LazyToolEntry> = new Map();

// ---------------------------------------------------------------------------
// Helper to add an entry to the registry
// ---------------------------------------------------------------------------

export function defineToolEntry(
  definition: MCPToolDefinition,
  loadHandler: () => Promise<ToolHandler>,
): void {
  const tier = getToolTier(definition.name);
  toolRegistry.set(definition.name, { definition, tier, loadHandler });
}

// ---------------------------------------------------------------------------
// Lazy handler resolution — loads once, caches forever
// ---------------------------------------------------------------------------

export async function resolveHandler(name: string): Promise<ToolHandler> {
  const entry = toolRegistry.get(name);
  if (!entry) {
    throw new Error(`No registry entry for tool: ${name}`);
  }
  if (entry._cachedHandler) {
    return entry._cachedHandler;
  }
  if (!entry._loading) {
    entry._loading = entry.loadHandler()
      .then(h => {
        if (typeof h !== 'function') {
          throw new Error(`Handler for tool "${name}" is not a function`);
        }
        entry._loading = undefined;
        entry._cachedHandler = h;
        return h;
      })
      .catch(err => {
        // Clear so a subsequent retry can attempt the load again.
        entry._loading = undefined;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load handler for tool "${name}": ${msg}`);
      });
  }
  return entry._loading;
}
