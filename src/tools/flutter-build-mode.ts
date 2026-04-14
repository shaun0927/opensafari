/**
 * flutter_build_mode — Detect the Flutter build mode (debug / profile / release)
 * of a running app and report which opensafari tools will work in that mode.
 *
 * Motivation (issue #442): when `flutter_connect` fails, users cannot tell
 * whether the cause is a misconfiguration or a release build (which disables
 * the Dart VM Service by design). This tool makes that state explicit and
 * directs users toward tools that still work in each mode.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { discoverVMServiceUrl } from '../flutter/vm-service-discovery';
import { getSessionManager } from '../session-manager';

export type FlutterBuildMode = 'debug' | 'profile' | 'release' | 'unknown';

export interface FlutterCapabilities {
  hot_reload: boolean;
  logs: boolean;
  widget_tree: boolean;
  evaluate: boolean;
  breakpoints: boolean;
  cpu_profile: boolean;
  heap_snapshot: boolean;
  network_proxy: boolean;
  ui_automation: boolean;
  screenshot: boolean;
}

/** Tools that remain usable in release mode (no VM Service required). */
const RELEASE_FALLBACK_TOOLS = [
  'app_tap_element',
  'app_assert_element',
  'app_wait_for',
  'app_screenshot_native',
  'app_tree',
  'app_logs',
  'app_crash_reports',
  'flutter_network', // HTTP proxy works regardless of build mode
];

function capabilitiesFor(mode: FlutterBuildMode): FlutterCapabilities {
  const vmAvailable = mode === 'debug' || mode === 'profile';
  return {
    hot_reload: mode === 'debug',
    logs: vmAvailable,
    widget_tree: vmAvailable,
    evaluate: vmAvailable,
    breakpoints: mode === 'debug',
    cpu_profile: vmAvailable,
    heap_snapshot: vmAvailable,
    network_proxy: true,
    ui_automation: true,
    screenshot: true,
  };
}

/**
 * Detect the build mode for a device. Strategy:
 *   1. If a VM client is already connected, inspect its isolate extensions
 *      (`_debug` / `_profile` / `_release` entries differ, and the absence
 *      of `reloadSources` implies non-debug).
 *   2. Otherwise, probe the simulator logs for a VM Service URL. Presence
 *      implies debug/profile; absence implies release (or not running).
 */
export async function detectBuildMode(
  deviceId: string,
  options?: { bundleId?: string; timeout?: number },
): Promise<{ mode: FlutterBuildMode; vmServiceAvailable: boolean; details: string }> {
  const client = getFlutterVMClient(deviceId);

  // Fast path: already connected → inspect isolate for mode hints.
  if (client.isConnected()) {
    try {
      const isolate = await client.getIsolate();
      const extensions = Array.isArray(isolate.extensionRPCs)
        ? (isolate.extensionRPCs as string[])
        : [];
      // Hot reload service extensions are only registered in debug mode.
      const hasHotReload = extensions.includes('ext.flutter.reassemble');
      return {
        mode: hasHotReload ? 'debug' : 'profile',
        vmServiceAvailable: true,
        details: `Active VM Service with ${extensions.length} extensions`,
      };
    } catch (err) {
      return {
        mode: 'unknown',
        vmServiceAvailable: true,
        details: `Connected but probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Slow path: look for a VM Service URL in the simulator logs.
  let discoveryError: string | null = null;
  try {
    const url = await discoverVMServiceUrl(deviceId, {
      bundleId: options?.bundleId,
      timeout: options?.timeout ?? 5000,
    });
    if (url) {
      // Discovery tells us VM Service is live but not whether it is debug
      // or profile — `ext.flutter.reassemble` is the authoritative signal
      // and is only observable via a live WebSocket connection. Leave the
      // mode as "unknown" so callers know to run flutter_connect for an
      // exact answer.
      return {
        mode: 'unknown',
        vmServiceAvailable: true,
        details: `VM Service URL discovered in logs (${url}); run flutter_connect to distinguish debug vs profile.`,
      };
    }
  } catch (err) {
    discoveryError = err instanceof Error ? err.message : String(err);
    console.error(`[flutter_build_mode] discovery error: ${discoveryError}`);
  }

  return {
    mode: 'release',
    vmServiceAvailable: false,
    details: discoveryError
      ? `Log search failed (${discoveryError}) — reporting release as a fallback, but this may be transient.`
      : 'No VM Service URL in recent logs — likely release build or app not running.',
  };
}

export function registerFlutterBuildModeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_build_mode',
      description:
        'Detect the Flutter build mode (debug / profile / release) of the running app ' +
        'and report which opensafari tools work in that mode. Use this when flutter_connect ' +
        'fails to determine whether the cause is a release build (VM Service disabled by design) ' +
        'or a configuration issue.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          bundle_id: {
            type: 'string',
            description: 'Bundle ID to scope log search (optional, improves accuracy)',
          },
          timeout_ms: {
            type: 'number',
            description: 'Log-search timeout in ms (default: 5000)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device. Boot a simulator first.');
        }

        const probe = await detectBuildMode(deviceId, {
          bundleId: params.bundle_id as string | undefined,
          timeout: params.timeout_ms as number | undefined,
        });

        const capabilities = capabilitiesFor(probe.mode);
        const fallbackTools = probe.vmServiceAvailable ? [] : RELEASE_FALLBACK_TOOLS;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: probe.mode,
              vm_service_available: probe.vmServiceAvailable,
              capabilities,
              fallback_tools: fallbackTools,
              details: probe.details,
              deviceId,
              hint: probe.vmServiceAvailable
                ? 'Run flutter_connect to enable VM-Service-backed tools.'
                : 'Release build detected. Use the fallback_tools list for UI automation and screenshots.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_build_mode] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
