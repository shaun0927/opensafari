import { MCPServer, getWebKitClient } from '../mcp-server';
import { WebKitClient } from '../webkit/client';
import { setWebKitClient } from '../mcp-server';
import { getSessionManager } from '../session-manager';

const DEFAULT_PROXY_HOST = 'localhost';
const DEFAULT_PROXY_PORT = 9222;

/**
 * Determine whether a target looks like a Safari browser tab vs a native app WebView.
 * Safari targets typically load http/https URLs and have titles like "Safari" or blank/about.
 * WebView targets often have app-specific schemes or titles tied to app bundle identifiers.
 */
function classifyTarget(target: { url: string; title: string; type?: string }): 'safari' | 'webview' {
  const url = target.url ?? '';
  // Explicit type hint from proxy
  if (target.type) {
    if (target.type.toLowerCase().includes('safari')) return 'safari';
    if (target.type.toLowerCase().includes('webview')) return 'webview';
  }
  // about:blank or empty URL — likely Safari new tab
  if (!url || url === 'about:blank') return 'safari';
  // file:// or custom scheme — WebView
  if (!url.startsWith('http://') && !url.startsWith('https://')) return 'webview';
  return 'safari';
}

export function registerAppWebviewConnectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_webview_connect',
      description:
        'Detect WebView targets inside a running native app and list available ones. After detection, use set_active_context to switch to a WebView target.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'Optional bundle ID to filter WebView targets by app',
          },
          deviceId: {
            type: 'string',
            description: 'Optional device UDID. Defaults to active device.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const deviceId = params.deviceId as string | undefined;
      const bundleId = params.bundleId as string | undefined;

      // Resolve device ID
      const resolvedDeviceId =
        deviceId ?? getSessionManager().getActiveDeviceId() ?? DEFAULT_PROXY_HOST;

      // Get or create a WebKit client
      let client = getWebKitClient(deviceId);
      if (!client) {
        const newClient = new WebKitClient({
          host: DEFAULT_PROXY_HOST,
          port: DEFAULT_PROXY_PORT,
        });
        setWebKitClient(newClient, resolvedDeviceId);
        client = newClient;
      }

      // List all targets from ios-webkit-debug-proxy
      let targets: Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string; type?: string }>;
      try {
        targets = await (client as any).listTargets?.() ?? [];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: Failed to list targets: ${message}` }],
          isError: true,
        };
      }

      // Classify and filter targets
      const classified = targets.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl,
        type: classifyTarget(t),
      }));

      // Filter to WebView targets only; optionally filter by bundleId in title/url
      let webviewTargets = classified.filter((t) => t.type === 'webview');
      if (bundleId) {
        webviewTargets = webviewTargets.filter(
          (t) =>
            t.title.toLowerCase().includes(bundleId.toLowerCase()) ||
            t.url.toLowerCase().includes(bundleId.toLowerCase()),
        );
      }

      const result = {
        deviceId: resolvedDeviceId,
        targets: webviewTargets.map(({ webSocketDebuggerUrl: _ws, ...rest }) => rest),
        count: webviewTargets.length,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
