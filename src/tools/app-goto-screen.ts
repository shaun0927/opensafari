/**
 * `app_goto_screen` — high-level verified semantic screen navigation.
 *
 * Dispatching a deeplink/tap/route mutation is not success. The tool first
 * checks whether the requested postcondition is already true, then tries the
 * requested transport, and only reports success when the postcondition is met.
 */

import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { ensureSemanticsActive } from '../native';
import { ErrorCode, respondWithStructuredError } from '../errors';
import {
  wrapHandlerForBundle,
  COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
} from './debug-bundle-attach';
import {
  hasScreenPostconditionSignal,
  navigateSemantically,
  type NativeFallbackQuery,
  type ScreenTargetPostcondition,
} from './semantic-navigation';

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

type WaitForSpec = ScreenTargetPostcondition;

export function registerAppGotoScreenTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_goto_screen',
      description:
        'High-level verified semantic navigation. Dispatches a deeplink only after an already-on-target check, optionally tries bounded native fallback queries, and reports success only when waitFor postcondition is met.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Deeplink URL (e.g. myapp://settings/account)' },
          waitFor: {
            type: 'object',
            description:
              'Required postcondition. Provide identifier, label, text, role, and/or Flutter route. Transport-only navigation is rejected as unverified.',
            properties: {
              label: { type: 'string' },
              identifier: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              route: { type: 'string', description: 'Optional Flutter route name to verify when VM Service is connected.' },
              timeoutMs: { type: 'number', description: 'Poll timeout (default 5000)' },
              stableMs: { type: 'number', description: 'Require the postcondition to hold continuously for this many ms before success.' },
            },
          },
          bundleId: { type: 'string', description: 'Target app bundle ID (forces ensureSemanticsActive scope)' },
          deviceId: { type: 'string' },
          allowNativeFallback: { type: 'boolean', description: 'When true, try bounded native fallback queries after already-on-target/deeplink strategies fail. Default false.' },
          nativeFallbackQueries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                identifier: { type: 'string' },
                label: { type: 'string' },
                text: { type: 'string' },
                role: { type: 'string' },
              },
            },
            description: 'Bounded native fallback elements to press/tap in order. Requires allowNativeFallback=true and every attempt is postcondition-verified.',
          },
          maxNativeAttempts: { type: 'number', description: 'Maximum native fallback attempts (default 3).' },
          collectDebugBundleOnFailure: COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
        },
        required: ['url', 'waitFor'],
      },
    },
    wrapHandlerForBundle('app_goto_screen', async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string | undefined;
      if (!url || !url.includes('://')) {
        return respondWithStructuredError(ErrorCode.INVALID_URL, 'url must include a scheme');
      }

      const waitForSpec = params.waitFor as WaitForSpec | undefined;
      if (!waitForSpec) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          'waitFor postcondition is required for app_goto_screen success; dispatch-only deeplinks are intentionally unverified',
          { url },
        );
      }
      if (!hasScreenPostconditionSignal(waitForSpec)) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          'waitFor requires at least one of identifier, label, text, role, or route',
          { waitFor: waitForSpec },
        );
      }

      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found');
      }

      const bundleId = params.bundleId as string | undefined;
      try {
        await ensureSemanticsActive(deviceId, { bundleId });
      } catch {
        // Continue — the settle loop tolerates AX errors as transient.
      }

      try {
        const result = await navigateSemantically({
          deviceId,
          url,
          bundleId,
          postcondition: waitForSpec,
          allowNativeFallback: params.allowNativeFallback === true,
          nativeFallbackQueries: Array.isArray(params.nativeFallbackQueries)
            ? (params.nativeFallbackQueries as NativeFallbackQuery[])
            : undefined,
          maxNativeAttempts: params.maxNativeAttempts as number | undefined,
        });

        if (!result.navigated && result.strategy === 'failed') {
          return respondWithStructuredError(
            ErrorCode.FLUTTER_EVAL_FAILED,
            'app_goto_screen postcondition was not met',
            { ...result },
          );
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message, {
          url,
          deviceId,
        });
      }
    }),
  );
}
