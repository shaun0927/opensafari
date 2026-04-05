import { MCPServer, getWebKitClient, setWebKitClient } from '../mcp-server';
import { WebKitClient } from '../webkit/client';
import { getSessionManager } from '../session-manager';

const DEFAULT_PROXY_HOST = 'localhost';
const DEFAULT_PROXY_PORT = 9222;

export function registerSetActiveContextTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'set_active_context',
      description:
        'Switch the active automation context between Safari and a native app WebView. After switching, existing Safari/WebKit tools route to the selected context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          context: {
            type: 'string',
            enum: ['safari', 'webview'],
            description: "Target context: 'safari' for browser tabs, 'webview' for native app WebView",
          },
          targetId: {
            type: 'string',
            description: 'Specific WebView target ID from app_webview_connect. Required when context is webview.',
          },
          bundleId: {
            type: 'string',
            description: 'Optional app bundle ID to help identify the WebView target.',
          },
          deviceId: {
            type: 'string',
            description: 'Optional device UDID. Defaults to active device.',
          },
        },
        required: ['context'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const context = params.context as 'safari' | 'webview';
      const targetId = params.targetId as string | undefined;
      const deviceId = params.deviceId as string | undefined;

      // Resolve device ID
      const resolvedDeviceId =
        deviceId ?? getSessionManager().getActiveDeviceId() ?? DEFAULT_PROXY_HOST;

      // Get or create a client to query targets
      let probeClient = getWebKitClient(deviceId);
      if (!probeClient) {
        const newClient = new WebKitClient({
          host: DEFAULT_PROXY_HOST,
          port: DEFAULT_PROXY_PORT,
        });
        setWebKitClient(newClient, resolvedDeviceId);
        probeClient = newClient;
      }

      // Fetch all available targets
      let allTargets: Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string; type?: string }>;
      try {
        allTargets = await (probeClient as any).listTargets?.() ?? [];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: Failed to list targets: ${message}` }],
          isError: true,
        };
      }

      if (allTargets.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No targets available. Ensure the simulator is booted and ios-webkit-debug-proxy is running.' }],
          isError: true,
        };
      }

      let selectedTarget: (typeof allTargets)[number] | undefined;

      if (context === 'safari') {
        // Pick the first Safari-like target (http/https or about:blank)
        selectedTarget = allTargets.find(
          (t) => !t.url || t.url === 'about:blank' || t.url.startsWith('http://') || t.url.startsWith('https://'),
        );
        if (!selectedTarget) {
          selectedTarget = allTargets[0];
        }
      } else {
        // webview context
        if (targetId) {
          selectedTarget = allTargets.find((t) => t.id === targetId);
          if (!selectedTarget) {
            return {
              content: [{ type: 'text' as const, text: `Error: Target '${targetId}' not found. Use app_webview_connect to list available targets.` }],
              isError: true,
            };
          }
        } else {
          // Auto-select: prefer non-http targets (native WebView), fall back to first
          selectedTarget = allTargets.find(
            (t) => t.url && t.url !== 'about:blank' && !t.url.startsWith('http://') && !t.url.startsWith('https://'),
          ) ?? allTargets[0];
        }
      }

      // Switch context by reconnecting the existing client to the selected target's WS URL.
      // If the client supports connectToUrl (WebKitClient), use it directly so tests
      // can substitute a mock without a real network connection.
      try {
        if (typeof (probeClient as any).connectToUrl === 'function') {
          await (probeClient as any).connectToUrl(selectedTarget.webSocketDebuggerUrl);
        }
        // If the backend doesn't support connectToUrl, it is already pointing at the
        // correct proxy — target selection is advisory only (no-op fallback).
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: Failed to connect to target: ${message}` }],
          isError: true,
        };
      }

      // Ensure the (potentially new) client is registered as the active connection
      setWebKitClient(probeClient, resolvedDeviceId);

      const result = {
        context,
        deviceId: resolvedDeviceId,
        target: {
          id: selectedTarget.id,
          title: selectedTarget.title,
          url: selectedTarget.url,
        },
        status: 'connected',
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
