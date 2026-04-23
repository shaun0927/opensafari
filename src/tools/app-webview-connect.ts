import { MCPServer, getWebKitClient, setWebKitClient } from '../mcp-server';
import { WebKitClient } from '../webkit/client';
import { getSessionManager } from '../session-manager';
import { getSharedProxy } from '../simulator/proxy';

const DEFAULT_PROXY_HOST = 'localhost';

type ClassificationReason = 'bundle_match' | 'proxy_type' | 'url_scheme';
type TargetType = 'safari' | 'webview';

interface ClassificationResult {
  type: TargetType;
  reason: ClassificationReason;
}

interface ListTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type?: string;
  appId?: string;
  bundleId?: string;
  app_id?: string;
}

/**
 * Determine whether a target looks like a Safari browser tab vs a native app WebView.
 *
 * Priority order (first match wins):
 * 1. bundle_match — ownerBundleId matches target metadata (appId/bundleId/app_id fields,
 *    or title/url substring). Classifies as webview.
 * 2. proxy_type — target has a `type` field from the proxy. Maps safari/mobilesafari →
 *    safari; any string containing "webview" → webview.
 * 3. url_scheme — fallback heuristic: empty/about:blank → safari; non-http(s) → webview;
 *    http(s) → safari.
 */
function classifyTarget(
  target: ListTarget,
  ownerBundleId?: string,
): ClassificationResult {
  // 1. bundle_match
  if (ownerBundleId) {
    const lower = ownerBundleId.toLowerCase();
    const metadataFields = [target.appId, target.bundleId, target.app_id];
    const metadataMatch = metadataFields.some(
      (field) => field !== undefined && field.toLowerCase() === lower,
    );
    const substringMatch =
      target.title.toLowerCase().includes(lower) ||
      target.url.toLowerCase().includes(lower);
    if (metadataMatch || substringMatch) {
      return { type: 'webview', reason: 'bundle_match' };
    }
  }

  // 2. proxy_type
  if (target.type) {
    const t = target.type.toLowerCase();
    if (t === 'safari' || t === 'mobilesafari') {
      return { type: 'safari', reason: 'proxy_type' };
    }
    if (t.includes('webview')) {
      return { type: 'webview', reason: 'proxy_type' };
    }
  }

  // 3. url_scheme fallback
  const url = target.url ?? '';
  if (!url || url === 'about:blank') return { type: 'safari', reason: 'url_scheme' };
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { type: 'webview', reason: 'url_scheme' };
  }
  return { type: 'safari', reason: 'url_scheme' };
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
        deviceId ?? getSessionManager().getSoleDeviceId() ?? DEFAULT_PROXY_HOST;

      // Get or create a WebKit client. Track whether we registered the
      // client on *this* call so the error path below can deregister only
      // what it created — a pre-existing client may be owned by a concurrent
      // tool call and must not be evicted on our transient failure.
      let client = getWebKitClient(deviceId);
      let clientWasFreshlyRegistered = false;
      if (!client) {
        const newClient = new WebKitClient({
          host: DEFAULT_PROXY_HOST,
          port: getSharedProxy().port,
        });
        setWebKitClient(newClient, resolvedDeviceId);
        client = newClient;
        clientWasFreshlyRegistered = true;
      }

      // List all targets from ios-webkit-debug-proxy
      let targets: ListTarget[];
      try {
        targets = await (client as any).listTargets?.() ?? [];
      } catch (err) {
        // Deregister only the freshly-created WebKit client so a subsequent
        // call does not reuse a stale, never-successfully-used instance (e.g.
        // when the proxy was briefly unreachable). We deliberately avoid
        // `setWebKitClient(null, …)` here because its clear branch also
        // removes the simulator entry from the session map — a device that
        // was already registered (via `device_boot` or another tool surface)
        // would then disappear from `getSoleDeviceId()` on a transient proxy
        // hiccup. `removeConnection` scopes the cleanup to the WebKit
        // connection only; pre-existing registrations are intentionally left
        // in place.
        if (clientWasFreshlyRegistered) {
          getSessionManager().removeConnection(resolvedDeviceId);
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: Failed to list targets: ${message}` }],
          isError: true,
        };
      }

      // Classify all targets
      const classified = targets.map((t) => {
        const { type, reason } = classifyTarget(t, bundleId);
        return {
          id: t.id,
          title: t.title,
          url: t.url,
          webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          type,
          classificationReason: reason,
        };
      });

      // Keep WebView targets only. When bundleId is provided, further restrict to targets
      // that either matched via bundle_match (already promoted) OR contain the bundleId
      // substring in title/url (backward-compatible filter for non-HTTPS webviews).
      const webviewTargets = classified.filter((t) => {
        if (t.type !== 'webview') return false;
        if (!bundleId) return true;
        return (
          t.classificationReason === 'bundle_match' ||
          t.title.toLowerCase().includes(bundleId.toLowerCase()) ||
          t.url.toLowerCase().includes(bundleId.toLowerCase())
        );
      });

      const result = {
        deviceId: resolvedDeviceId,
        targets: webviewTargets.map(({ webSocketDebuggerUrl: _ws, ...rest }) => rest),
        count: webviewTargets.length,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
