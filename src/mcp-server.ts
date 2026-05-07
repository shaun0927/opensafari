/**
 * OpenSafari MCP Server
 * Handles JSON-RPC 2.0 protocol, tool registration, and progressive disclosure.
 * Safari-specific tools are registered externally via registerTool().
 *
 * Chrome/CDP references have been removed. Safari/WebKit/Simulator placeholders
 * are in place; actual implementations land in Epic 1B/1C.
 */

import {
  MCPRequest,
  MCPResponse,
  MCPResult,
  MCPToolDefinition,
  ToolHandler,
  MCPErrorCodes,
} from './types/mcp';
import { createTransport, MCPTransport, TransportMode } from './transports';
import { TOOL_TIERS, getToolTier } from './config/tool-tiers';
import { BrowserBackend } from './types/browser-backend';
import { logAuditEntry } from './security/audit-logger';
import { getSessionManager } from './session-manager';
import { getVersion } from './version';
import { resolveHandler } from './tools/registry';

// Re-export so callers can use canonical names without knowing the internal alias
export type { MCPToolDefinition as ToolDefinition, ToolHandler };
export { TOOL_TIERS, getToolTier };

// ---------------------------------------------------------------------------
// Global WebKit client accessor — delegates to SessionManager.
// All tools call getWebKitClient() to obtain the active BrowserBackend.
// With SessionManager integration, multiple devices are tracked and the
// active device connection is returned by default.
// ---------------------------------------------------------------------------

/**
 * Get the WebKit client for a specific device or the active device.
 * @param deviceId - Optional device UDID. Falls back to active device.
 */
export function getWebKitClient(deviceId?: string): BrowserBackend | null {
  return getSessionManager().getConnection(deviceId);
}

/**
 * Register a WebKit client for a device and set it as active.
 * @deprecated Prefer registering via SessionManager directly.
 * Kept for backward compatibility with device_boot and tests.
 */
const LEGACY_DEVICE_ID = '__default__';

export function setWebKitClient(client: BrowserBackend | null, deviceId?: string): void {
  const sm = getSessionManager();
  const id = deviceId ?? LEGACY_DEVICE_ID;

  if (client) {
    // Ensure a simulator entry exists for legacy callers (e.g. tests)
    if (!sm.getSimulator(id)) {
      sm.addSimulator(id, {
        deviceId: id,
        deviceType: 'legacy',
        state: 'booted',
        viewport: { width: 390, height: 844 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
    }
    sm.setConnection(id, client);
  } else {
    // Clear: remove the specified or sole device's connection
    const soleId = sm.getSoleDeviceId();
    const targetId = deviceId ?? soleId;
    if (targetId) {
      sm.removeConnection(targetId);
      sm.removeSimulator(targetId);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal registry entry
// ---------------------------------------------------------------------------

interface RegisteredTool {
  definition: MCPToolDefinition;
  /** Eagerly-provided handler (registerTool path). */
  handler?: ToolHandler;
  /** When true, handler is resolved lazily from the tool registry on first call. */
  lazy?: boolean;
  tier: number;
}

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

export interface MCPServerOptions {
  /** Wire transport to use. Defaults to 'stdio'. */
  transport?: TransportMode;
  /** HTTP port — only relevant when transport === 'http'. */
  port?: number;
}

export class MCPServer {
  private tools: Map<string, RegisteredTool> = new Map();
  private transport: MCPTransport | null = null;
  private currentTier: number = 2;
  private auditLogEnabled = false;

  // ------------------------------------------------------------------
  // Tool registration
  // ------------------------------------------------------------------

  registerTool(definition: MCPToolDefinition, handler: ToolHandler): void {
    const tier = getToolTier(definition.name);
    this.tools.set(definition.name, { definition, handler, tier });
  }

  /**
   * Register a tool whose handler is loaded lazily from the tool registry on
   * first invocation.  The schema and tier are available immediately so
   * tools/list works without triggering any dynamic import.
   */
  registerLazyTool(definition: MCPToolDefinition): void {
    const tier = getToolTier(definition.name);
    this.tools.set(definition.name, { definition, lazy: true, tier });
  }

  getToolHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start(options: MCPServerOptions = {}): Promise<void> {
    const mode: TransportMode = options.transport ?? 'stdio';
    this.transport = await createTransport(mode, { port: options.port });

    this.transport.onMessage((msg) => this.handleMessage(msg));
    await this.transport.start();

    console.error(`[OpenSafari] MCP server started (${mode})`);
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    console.error('[OpenSafari] MCP server stopped');
  }

  // ------------------------------------------------------------------
  // Progressive disclosure
  // ------------------------------------------------------------------

  setTier(tier: number): void {
    this.currentTier = tier;
  }

  getTier(): number {
    return this.currentTier;
  }

  enableAuditLog(): void {
    this.auditLogEnabled = true;
  }

  // ------------------------------------------------------------------
  // Message routing
  // ------------------------------------------------------------------

  private async handleMessage(
    msg: Record<string, unknown>,
  ): Promise<MCPResponse | null> {
    // Notifications have no id — process but return null (no response)
    const hasId = 'id' in msg && msg.id !== undefined;
    const id = (msg.id as number | string) ?? 0;
    const method = msg.method as string | undefined;

    if (!method) {
      if (!hasId) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCPErrorCodes.INVALID_REQUEST,
          message: 'Missing method field',
        },
      };
    }

    // Notifications (no id) — handle silently where needed, then drop
    if (!hasId) {
      // e.g. notifications/initialized — no response required
      return null;
    }

    const request = msg as unknown as MCPRequest;

    switch (method) {
      case 'initialize':
        return this.handleInitialize(request);

      case 'tools/list':
        return this.handleToolsList(request);

      case 'tools/call':
        return this.handleToolsCall(request);

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCPErrorCodes.METHOD_NOT_FOUND,
            message: `Method not found: ${method}`,
          },
        };
    }
  }

  // ------------------------------------------------------------------
  // Method handlers
  // ------------------------------------------------------------------

  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'opensafari-mcp',
          version: getVersion(),
        },
      },
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    const visibleTools = Array.from(this.tools.values())
      .filter((t) => t.tier <= this.currentTier)
      .map((t) => t.definition);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: visibleTools },
    };
  }

  private async handleToolsCall(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as
      | { name?: string; arguments?: Record<string, unknown> }
      | undefined;

    const name = params?.name;
    const args = params?.arguments ?? {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.INVALID_PARAMS,
          message: 'tools/call requires params.name',
        },
      };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.INVALID_PARAMS,
          message: `Unknown tool: ${name}`,
        },
      };
    }

    // Session ID: use Mcp-Session-Id from context if available; fall back to
    // a stable placeholder until the HTTP transport propagates it here.
    const sessionId = (request.params as Record<string, unknown> | undefined)
      ?._sessionId as string | undefined ?? 'default';

    // Resolve the handler — either eager (already attached) or lazy (registry).
    let handler: ToolHandler;
    if (tool.handler) {
      handler = tool.handler;
    } else if (tool.lazy) {
      try {
        handler = await resolveHandler(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `Error: ${msg}` }],
            isError: true,
          },
        };
      }
    } else {
      // Should never happen — registerTool always sets handler.
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Error: no handler registered for tool "${name}"` }],
          isError: true,
        },
      };
    }

    try {
      const result: MCPResult = await handler(sessionId, args);
      if (this.auditLogEnabled) {
        logAuditEntry(name, sessionId, args);
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (err) {
      if (this.auditLogEnabled) {
        logAuditEntry(name, sessionId, args);
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        },
      };
    }
  }
}
