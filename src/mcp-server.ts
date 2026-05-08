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
  MCPMessageContext,
} from './types/mcp';
import { createTransport, MCPTransport, TransportMode } from './transports';
import { TOOL_TIERS, getToolTier } from './config/tool-tiers';
import { BrowserBackend } from './types/browser-backend';
import { logAuditEntry } from './security/audit-logger';
import {
  buildHttpHighRiskToolError,
  getHighRiskToolMetadata,
  parseHttpHighRiskToolsEnabled,
} from './security/high-risk-tools';
import { getSessionManager } from './session-manager';
import { getVersion } from './version';
import { resolveHandler, toolRegistry } from './tools/registry';

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
  /** HTTP host — only relevant when transport === 'http'. Defaults to loopback. */
  host?: string;
  /** Bearer token required for HTTP /mcp requests. */
  authToken?: string;
  /** Explicitly disable HTTP /mcp token auth for local-only insecure use. */
  httpInsecure?: boolean;
  /** Extra allowed browser origins for HTTP /mcp CORS. */
  allowedOrigins?: string[];
  /** Allow high-risk code execution / credential movement tools over HTTP. */
  httpHighRiskTools?: boolean;
}

export class MCPServer {
  private tools: Map<string, RegisteredTool> = new Map();
  private transport: MCPTransport | null = null;
  private currentTier: number = 2;
  private auditLogEnabled = false;
  private httpHighRiskToolsEnabled = false;

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
    const entry = toolRegistry.get(definition.name);
    if (!entry) {
      throw new Error(
        `Cannot register lazy tool "${definition.name}": ` +
        `no entry found in toolRegistry. Call defineToolEntry() first.`,
      );
    }
    // Warn if caller-provided definition drifts from the registry's source of truth.
    if (
      definition.description !== entry.definition.description ||
      JSON.stringify(definition.inputSchema) !== JSON.stringify(entry.definition.inputSchema)
    ) {
      console.error(
        `[mcp-server] registerLazyTool: caller definition for "${definition.name}" differs from toolRegistry entry. ` +
        `Using registry version.`,
      );
    }
    const tier = getToolTier(definition.name);
    // Use the registry's definition as the single source of truth for schema.
    this.tools.set(definition.name, { definition: entry.definition, lazy: true, tier });
  }

  /**
   * Returns the handler implementation for a registered tool, or
   * undefined if no tool with that name is registered OR if the tool
   * is lazy and has not yet been invoked.
   *
   * Lazy tools are registered with their schema only; the handler is
   * resolved on first tools/call. Callers that need the handler before
   * an invocation should wait for the first tools/call to complete or
   * use the async path through handleToolsCall.
   */
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
    this.httpHighRiskToolsEnabled =
      options.httpHighRiskTools === true ||
      parseHttpHighRiskToolsEnabled(process.env.OPENSAFARI_HTTP_ENABLE_HIGH_RISK_TOOLS);
    this.transport = await createTransport(mode, {
      port: options.port,
      host: options.host,
      authToken: options.authToken,
      insecure: options.httpInsecure,
      allowedOrigins: options.allowedOrigins,
    });

    this.transport.onMessage((msg, context) => this.handleMessage(msg, context));
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
    context: MCPMessageContext = { transport: 'stdio' },
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
        return this.handleToolsList(request, context);

      case 'tools/call':
        return this.handleToolsCall(request, context);

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

  private handleToolsList(request: MCPRequest, context: MCPMessageContext): MCPResponse {
    const visibleTools = Array.from(this.tools.values())
      .filter((t) => t.tier <= this.currentTier)
      .filter((t) => this.shouldAdvertiseTool(t.definition.name, context))
      .map((t) => t.definition);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: visibleTools },
    };
  }

  private shouldAdvertiseTool(name: string, context: MCPMessageContext): boolean {
    if (context.transport !== 'http') return true;
    if (this.httpHighRiskToolsEnabled) return true;
    return getHighRiskToolMetadata(name) === undefined;
  }

  private async handleToolsCall(request: MCPRequest, context: MCPMessageContext): Promise<MCPResponse> {
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

    const sessionId = context.sessionId ?? 'default';
    const highRiskTool = getHighRiskToolMetadata(name);
    const isHighRiskHttp = context.transport === 'http' && highRiskTool !== undefined;

    if (isHighRiskHttp && !this.httpHighRiskToolsEnabled) {
      logAuditEntry(name, sessionId, args, undefined, 'denied');
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{
            type: 'text',
            text: `Error: ${buildHttpHighRiskToolError(name)}`,
          }],
          isError: true,
        },
      };
    }

    // Resolve the handler — either eager (already attached) or lazy (registry).
    let handler: ToolHandler;
    if (tool.handler) {
      handler = tool.handler;
    } else if (tool.lazy) {
      try {
        handler = await resolveHandler(name);
        tool.handler = handler;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.auditLogEnabled) {
          logAuditEntry(name, sessionId, args);
        }
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: `Failed to load handler for tool "${name}": ${msg}`,
          },
        };
      }
    } else {
      // Should never happen — registerTool always sets handler.
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.INTERNAL_ERROR,
          message: `Internal error: no handler registered for tool "${name}"`,
        },
      };
    }

    try {
      const result: MCPResult = await handler(sessionId, args);
      if (this.auditLogEnabled || isHighRiskHttp) {
        logAuditEntry(name, sessionId, args, undefined, 'allowed');
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (err) {
      if (this.auditLogEnabled || isHighRiskHttp) {
        logAuditEntry(name, sessionId, args, undefined, 'error');
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
