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
 *   waitFor       — required postcondition. After the openurl succeeds,
 *                   poll the AX tree until an element matching this label /
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
import { ensureSemanticsActive } from '../native';
import { ErrorCode, respondWithStructuredError } from '../errors';
import {
  wrapHandlerForBundle,
  COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
} from './debug-bundle-attach';
import { collectAppSessionState } from './app-state-snapshot';
import { waitForSettle } from './settle-policy';

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
  stableMs?: number;
}

export function registerAppGotoScreenTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_goto_screen',
      description:
        'High-level "take me to this screen" macro. Dispatches a deeplink via simctl openurl, then requires a waitFor postcondition to verify the target screen before reporting success. Collapses the common app_deeplink → app_wait_for sequence into a single call.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Deeplink URL (e.g. myapp://settings/account)' },
          waitFor: {
            type: 'object',
            description:
              'Required postcondition. The tool polls the AX tree until at least one node matches the supplied label / identifier / text / role, or the timeout fires. Dispatch-only deeplink calls are rejected as unverified.',
            properties: {
              label: { type: 'string' },
              identifier: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              timeoutMs: { type: 'number', description: 'Poll timeout (default 5000)' },
              stableMs: { type: 'number', description: 'Require the postcondition to hold continuously for this many ms before success.' },
            },
          },
          bundleId: { type: 'string', description: 'Target app bundle ID (forces ensureSemanticsActive scope)' },
          deviceId: { type: 'string' },
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
      if (!hasWaitForSignal(waitForSpec)) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          'waitFor requires at least one of identifier, label, text, or role',
          { waitFor: waitForSpec },
        );
      }

      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found');
      }

      // Make sure semantics are active before we start polling.
      const bundleId = params.bundleId as string | undefined;
      try {
        await ensureSemanticsActive(deviceId, { bundleId });
      } catch {
        // Continue — the poll loop tolerates AX errors as transient.
      }

      const attempts: Array<{
        strategy: string;
        elapsedMs: number;
        ok: boolean;
        skipped?: boolean;
        skipReason?: string;
        verification?: unknown;
        error?: string;
      }> = [];

      let beforeState: unknown;
      try {
        beforeState = await collectAppSessionState({
          deviceId,
          expectedBundleId: bundleId,
          includeFlutter: true,
          maxVisibleNodes: 12,
        });
      } catch (err) {
        attempts.push({
          strategy: 'state_snapshot',
          elapsedMs: 0,
          ok: false,
          skipped: true,
          skipReason: err instanceof Error ? err.message : String(err),
        });
      }

      if (waitForSpec) {
        const alreadyStart = Date.now();
        try {
          const pre = await waitForSettle(deviceId, {
            query: {
              identifier: waitForSpec.identifier,
              label: waitForSpec.label,
              text: waitForSpec.text,
              role: waitForSpec.role,
            },
            condition: 'exists',
            timeoutMs: 250,
            intervalMs: 100,
            stableMs: 0,
            allowTransientErrors: true,
            maxRecoverableRetries: 1,
          });
          attempts.push({
            strategy: 'already_on_target',
            elapsedMs: Date.now() - alreadyStart,
            ok: pre.met,
            verification: pre,
          });
          if (pre.met) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  navigated: false,
                  strategy: 'already_on_target',
                  url,
                  deviceId,
                  beforeState,
                  afterState: beforeState,
                  attempts,
                  waitFor: { ...waitForSpec, matched: true, elapsedMs: pre.elapsedMs, matchCount: pre.matchingCount },
                  verification: pre,
                }, null, 2),
              }],
            };
          }
        } catch (err) {
          attempts.push({
            strategy: 'already_on_target',
            elapsedMs: Date.now() - alreadyStart,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Dispatch the deeplink only after the non-mutating already-on-target
      // check has failed. This preserves the semantic navigation contract:
      // when the requested postcondition is already true, the tool returns
      // without perturbing the app state.
      const openedAt = Date.now();
      try {
        await execFileAsync('xcrun', ['simctl', 'openurl', deviceId, url]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({
          strategy: 'deeplink',
          elapsedMs: Date.now() - openedAt,
          ok: false,
          error: message,
        });
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message, {
          url,
          deviceId,
          beforeState,
          attempts,
        });
      }

      const verifyStart = Date.now();
      let verification: unknown;
      let verdict: { matched: boolean; elapsedMs: number; matchCount: number };
      const settle = await waitForSettle(deviceId, {
        query: {
          identifier: waitForSpec.identifier,
          label: waitForSpec.label,
          text: waitForSpec.text,
          role: waitForSpec.role,
        },
        condition: 'exists',
        timeoutMs: waitForSpec.timeoutMs ?? 5000,
        intervalMs: 250,
        stableMs: waitForSpec.stableMs ?? 0,
        allowTransientErrors: true,
        maxRecoverableRetries: 3,
      });
      verification = settle;
      verdict = { matched: settle.met, elapsedMs: settle.elapsedMs, matchCount: settle.matchingCount };
      attempts.push({
        strategy: 'deeplink_postcondition',
        elapsedMs: Date.now() - verifyStart,
        ok: settle.met,
        verification: settle,
      });
      let afterState: unknown;
      try {
        afterState = await collectAppSessionState({
          deviceId,
          expectedBundleId: bundleId,
          includeFlutter: true,
          maxVisibleNodes: 12,
        });
      } catch {
        afterState = undefined;
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            navigated: true,
            strategy: 'deeplink',
            url,
            deviceId,
            openedAt: new Date(openedAt).toISOString(),
            beforeState,
            afterState,
            attempts,
            waitFor: { ...waitForSpec, ...verdict },
            verification,
          }, null, 2),
        }],
        isError: !verdict.matched,
      };
    }),
  );
}

function hasWaitForSignal(spec: WaitForSpec): boolean {
  return Boolean(spec.identifier || spec.label || spec.text || spec.role);
}
