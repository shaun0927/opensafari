/**
 * `app_goto_screen` — high-level "take me to this screen" macro.
 *
 * Composes a deeplink open with a post-condition wait, so cross-screen
 * navigation that previously took the LLM 3-4 separate calls
 * (`app_deeplink` → `app_wait_for` → maybe `app_tap_element` to land
 * on the exact tab) collapses into a single semantic action.
 *
 * Input
 *   url           — required. The deeplink to dispatch via `simctl
 *                   openurl`. Callers can mint this from
 *                   `app_list_routes` (#779) if they need to discover
 *                   what's supported.
 *   waitFor       — optional. After the openurl succeeds, poll the AX
 *                   tree until an element matching this label /
 *                   identifier appears. Default timeout 5000 ms.
 *
 * On failure the response uses StructuredErrorException's MCP shape so
 * the caller's auto-retry layer can introspect `recoverable` /
 * `suggestion`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import { ErrorCode, respondWithStructuredError } from '../errors';
import {
  wrapHandlerForBundle,
  COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
} from './debug-bundle-attach';

const execFileAsync = promisify(execFile);

async function resolveDeviceId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const sole = getSessionManager().getSoleDeviceId();
  if (sole) return sole;
  try {
    const booted = await new SimulatorManager().listBooted();
    if (booted.length === 1) return booted[0].udid;
  } catch {
    // simctl unavailable
  }
  return null;
}

interface WaitForSpec {
  label?: string;
  identifier?: string;
  role?: string;
  text?: string;
  timeoutMs?: number;
}

async function waitForElement(
  deviceId: string,
  spec: WaitForSpec,
): Promise<{ matched: boolean; elapsedMs: number; matchCount: number }> {
  const bridge = getAccessibilityBridge();
  const deadline = Date.now() + (spec.timeoutMs ?? 5000);
  const start = Date.now();
  const query = {
    identifier: spec.identifier,
    label: spec.label,
    text: spec.text,
    role: spec.role,
  };
  while (Date.now() < deadline) {
    try {
      const result = await bridge.query(query, { deviceId });
      if (result.matches.length > 0) {
        return {
          matched: true,
          elapsedMs: Date.now() - start,
          matchCount: result.matches.length,
        };
      }
    } catch {
      // best-effort; loop will retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { matched: false, elapsedMs: Date.now() - start, matchCount: 0 };
}

export function registerAppGotoScreenTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_goto_screen',
      description:
        'High-level "take me to this screen" macro. Dispatches a deeplink via simctl openurl, then optionally polls the AX tree until a verification element appears. Collapses the common app_deeplink → app_wait_for sequence into a single call.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Deeplink URL (e.g. myapp://settings/account)' },
          waitFor: {
            type: 'object',
            description:
              'Optional post-condition. The tool polls the AX tree until at least one node matches the supplied label / identifier / text / role, or the timeout fires.',
            properties: {
              label: { type: 'string' },
              identifier: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              timeoutMs: { type: 'number', description: 'Poll timeout (default 5000)' },
            },
          },
          bundleId: { type: 'string', description: 'Target app bundle ID (forces ensureSemanticsActive scope)' },
          deviceId: { type: 'string' },
          collectDebugBundleOnFailure: COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
        },
        required: ['url'],
      },
    },
    wrapHandlerForBundle('app_goto_screen', async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string | undefined;
      if (!url || !url.includes('://')) {
        return respondWithStructuredError(ErrorCode.INVALID_URL, 'url must include a scheme');
      }

      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found');
      }

      // Dispatch the deeplink. We shell out directly rather than calling
      // the app_deeplink handler so this tool is a pure composition
      // (no MCP transport indirection).
      const openedAt = Date.now();
      try {
        await execFileAsync('xcrun', ['simctl', 'openurl', deviceId, url]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message, { url, deviceId });
      }

      // Make sure semantics are active before we start polling.
      const bundleId = params.bundleId as string | undefined;
      try {
        await ensureSemanticsActive(deviceId, { bundleId });
      } catch {
        // Continue — the poll loop tolerates AX errors as transient.
      }

      const waitForSpec = params.waitFor as WaitForSpec | undefined;
      if (!waitForSpec) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              navigated: true,
              url,
              deviceId,
              openedAt: new Date(openedAt).toISOString(),
              waitFor: null,
            }),
          }],
        };
      }

      const verdict = await waitForElement(deviceId, waitForSpec);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            navigated: true,
            url,
            deviceId,
            openedAt: new Date(openedAt).toISOString(),
            waitFor: { ...waitForSpec, ...verdict },
          }),
        }],
        isError: !verdict.matched,
      };
    }),
  );
}
