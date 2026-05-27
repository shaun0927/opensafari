import { MCPServer, getWebKitClient } from '../mcp-server';
import {
  type InterceptorClient,
  type InterceptRule,
} from '../network-interceptor';
import { ErrorCode, respondWithStructuredError } from '../errors';
import {
  getNetworkInterceptorForSession,
  networkInterceptor,
  removeNetworkInterceptorForSession,
  resetNetworkInterceptorsForTest,
} from './network-intercept-cache';

export {
  getNetworkInterceptorForSession,
  networkInterceptor,
  removeNetworkInterceptorForSession,
  resetNetworkInterceptorsForTest,
};

function resolveClient(deviceId: unknown): InterceptorClient | null {
  return getWebKitClient(typeof deviceId === 'string' ? deviceId : undefined);
}

/**
 * @internal Exported so the schema-validation contract can be unit-tested
 * directly without standing up the full MCP tool handler.
 */
export function mapRule(params: Record<string, unknown>): Omit<InterceptRule, 'id'> {
  const urlPattern = params.urlPattern as string | undefined;
  if (!urlPattern) {
    throw new Error('urlPattern is required when clear is not set');
  }

  // Validate explicitly: the JSON Schema declares `enum: ['block', 'modify']`
  // but MCP runtime schema enforcement is not guaranteed for every client, so
  // a typo like `"blok"` would otherwise be silently coerced to "mock" by the
  // fallthrough below (Codex review on PR #762). Reject unknown values up
  // front instead of rewriting requests in ways callers won't expect.
  const rawAction = params.action;
  if (rawAction !== undefined && rawAction !== 'block' && rawAction !== 'modify') {
    throw new Error(
      `action must be "block" or "modify" (got ${JSON.stringify(rawAction)})`,
    );
  }
  const action = (rawAction as 'block' | 'modify' | undefined) ?? 'block';
  if (action === 'block') return { urlPattern, action: 'block' };

  const statusCode = typeof params.statusCode === 'number' ? params.statusCode : 200;
  const body = typeof params.body === 'string' ? params.body : '';
  return {
    urlPattern,
    action: 'mock',
    mockResponse: {
      status: statusCode,
      headers: { 'Content-Type': 'text/plain' },
      body,
    },
  };
}

export function registerNetworkInterceptTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_intercept',
      description:
        'Intercept and modify network requests in Safari. Can block requests matching a URL pattern or return a custom response. Uses JavaScript injection to override fetch and XMLHttpRequest.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          urlPattern: {
            type: 'string',
            description: 'URL pattern to match (substring/glob match against request URL)',
          },
          action: {
            type: 'string',
            enum: ['block', 'modify'],
            description: 'Action to take: "block" rejects the request, "modify" returns a custom response',
          },
          statusCode: {
            type: 'number',
            description: 'HTTP status code for modified response (used with action "modify", default 200)',
          },
          body: {
            type: 'string',
            description: 'Response body for modified response (used with action "modify")',
          },
          clear: {
            type: 'boolean',
            description: 'If true, remove all intercept rules and restore original network behavior for this MCP session',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID / WebKit connection to target (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (sessionId: string, params: Record<string, unknown>) => {
      const client = resolveClient(params.device_id);
      if (!client) {
        return respondWithStructuredError(ErrorCode.BACKEND_NOT_CONNECTED, 'Safari not connected');
      }

      const deviceId = typeof params.device_id === 'string' ? params.device_id : undefined;
      const interceptor = getNetworkInterceptorForSession(sessionId, deviceId);
      if (params.clear === true) {
        await interceptor.disable(client);
        return { content: [{ type: 'text' as const, text: 'All intercept rules cleared' }] };
      }

      let rule: InterceptRule;
      try {
        rule = interceptor.addRule(mapRule(params));
      } catch (err) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, err instanceof Error ? err.message : String(err));
      }

      await interceptor.enable(client);

      const action = rule.action === 'mock' ? 'modify' : 'block';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'intercepting',
              ruleId: rule.id,
              urlPattern: rule.urlPattern,
              action,
              ...(rule.mockResponse ? { statusCode: rule.mockResponse.status, body: rule.mockResponse.body } : {}),
              totalRules: interceptor.listRules().length,
            }),
          },
        ],
      };
    },
  );
}
