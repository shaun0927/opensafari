import { MCPServer, getWebKitClient } from '../mcp-server';
import { BrowserBackend } from '../types/browser-backend';

/**
 * Network interceptor state manager.
 *
 * Uses JavaScript injection to intercept fetch/XHR requests in Safari.
 * WebKit Remote Debugging Protocol does not expose a Network interception
 * domain, so we override window.fetch and XMLHttpRequest at the page level.
 */
class NetworkInterceptor {
  private offline = false;

  /**
   * Enable or disable offline simulation by overriding fetch and XHR.
   */
  async setOffline(enabled: boolean, client: BrowserBackend): Promise<void> {
    this.offline = enabled;

    const script = enabled
      ? `(function() {
  if (window.__opensafariOfflineActive) return;
  window.__opensafariOfflineActive = true;
  window.__opensafariOriginalFetch = window.fetch;
  window.__opensafariOriginalXHROpen = XMLHttpRequest.prototype.open;
  window.__opensafariOriginalXHRSend = XMLHttpRequest.prototype.send;

  window.fetch = function() {
    return Promise.reject(new TypeError('Failed to fetch'));
  };

  XMLHttpRequest.prototype.open = function() {
    this.__opensafariArgs = arguments;
    return window.__opensafariOriginalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var xhr = this;
    setTimeout(function() {
      if (typeof xhr.onerror === 'function') {
        xhr.onerror(new Event('error'));
      }
      xhr.dispatchEvent(new Event('error'));
    }, 0);
  };
})()`
      : `(function() {
  if (!window.__opensafariOfflineActive) return;
  window.__opensafariOfflineActive = false;
  if (window.__opensafariOriginalFetch) {
    window.fetch = window.__opensafariOriginalFetch;
    delete window.__opensafariOriginalFetch;
  }
  if (window.__opensafariOriginalXHROpen) {
    XMLHttpRequest.prototype.open = window.__opensafariOriginalXHROpen;
    delete window.__opensafariOriginalXHROpen;
  }
  if (window.__opensafariOriginalXHRSend) {
    XMLHttpRequest.prototype.send = window.__opensafariOriginalXHRSend;
    delete window.__opensafariOriginalXHRSend;
  }
})()`;

    await client.evaluate(script);
  }

  /**
   * Return current offline state.
   */
  isOffline(): boolean {
    return this.offline;
  }
}

export const networkInterceptor = new NetworkInterceptor();

interface InterceptRule {
  urlPattern: string;
  action: 'block' | 'modify';
  statusCode?: number;
  body?: string;
}

const activeRules: InterceptRule[] = [];

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
            description: 'URL pattern to match (substring match against request URL)',
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
            description: 'If true, remove all intercept rules and restore original network behavior',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };

      const clear = params.clear as boolean | undefined;
      if (clear) {
        activeRules.length = 0;
        const restoreScript = `(function() {
  if (window.__opensafariInterceptActive) {
    window.__opensafariInterceptActive = false;
    if (window.__opensafariInterceptOriginalFetch) {
      window.fetch = window.__opensafariInterceptOriginalFetch;
      delete window.__opensafariInterceptOriginalFetch;
    }
  }
})()`;
        await client.evaluate(restoreScript);
        return { content: [{ type: 'text' as const, text: 'All intercept rules cleared' }] };
      }

      const urlPattern = params.urlPattern as string | undefined;
      if (!urlPattern) {
        return {
          content: [{ type: 'text' as const, text: 'Error: urlPattern is required when clear is not set' }],
          isError: true,
        };
      }

      const action = ((params.action as string) || 'block') as 'block' | 'modify';
      const statusCode = (params.statusCode as number) || 200;
      const body = (params.body as string) || '';

      const rule: InterceptRule = { urlPattern, action, statusCode, body };
      activeRules.push(rule);

      const rulesJson = JSON.stringify(activeRules);
      const interceptScript = `(function() {
  window.__opensafariInterceptRules = ${rulesJson};
  if (window.__opensafariInterceptActive) return;
  window.__opensafariInterceptActive = true;
  window.__opensafariInterceptOriginalFetch = window.fetch;

  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var rules = window.__opensafariInterceptRules || [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (url.indexOf(rule.urlPattern) !== -1) {
        if (rule.action === 'block') {
          return Promise.reject(new TypeError('Request blocked by intercept rule'));
        }
        if (rule.action === 'modify') {
          return Promise.resolve(new Response(rule.body || '', {
            status: rule.statusCode || 200,
            headers: { 'Content-Type': 'text/plain' }
          }));
        }
      }
    }
    return window.__opensafariInterceptOriginalFetch.apply(this, arguments);
  };
})()`;

      await client.evaluate(interceptScript);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'intercepting',
              urlPattern,
              action,
              ...(action === 'modify' ? { statusCode, body } : {}),
              totalRules: activeRules.length,
            }),
          },
        ],
      };
    },
  );
}
