import { MCPServer, getWebKitClient } from '../mcp-server';
import {
  NetworkInterceptor,
  type InterceptorClient,
  type InterceptRule,
} from '../network-interceptor';

const DEFAULT_INTERCEPTOR_SCOPE = '__default__';
const interceptorsBySession = new Map<string, NetworkInterceptor>();

export function getNetworkInterceptorForSession(sessionId?: string): NetworkInterceptor {
  const key = sessionId || DEFAULT_INTERCEPTOR_SCOPE;
  let interceptor = interceptorsBySession.get(key);
  if (!interceptor) {
    interceptor = new NetworkInterceptor();
    interceptorsBySession.set(key, interceptor);
  }
  return interceptor;
}

export function resetNetworkInterceptorsForTest(): void {
  interceptorsBySession.clear();
}

/** Legacy singleton for callers that are not yet session-aware. */
export const networkInterceptor = getNetworkInterceptorForSession(DEFAULT_INTERCEPTOR_SCOPE);

function resolveClient(deviceId: unknown): InterceptorClient | null {
  return getWebKitClient(typeof deviceId === 'string' ? deviceId : undefined);
}

function mapRule(params: Record<string, unknown>): Omit<InterceptRule, 'id'> {
  const urlPattern = params.urlPattern as string | undefined;
  if (!urlPattern) {
    throw new Error('urlPattern is required when clear is not set');
  }

  const action = ((params.action as string) || 'block') as 'block' | 'modify';
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
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      }

      const interceptor = getNetworkInterceptorForSession(sessionId);
      if (params.clear === true) {
        await interceptor.disable(client);
        return { content: [{ type: 'text' as const, text: 'All intercept rules cleared' }] };
      }

      let rule: InterceptRule;
      try {
        rule = interceptor.addRule(mapRule(params));
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
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
