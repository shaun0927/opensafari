/**
 * app_wait_for — Wait for a native UI element to appear in the accessibility tree.
 *
 * Polls the accessibility tree at intervals until an element matching the
 * query appears (or disappears), or timeout is reached. Essential for
 * reliable automation after navigation, animations, or async data loading.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, activateSemanticsOrWarn } from '../native';
import type { AXNode } from '../native';
import { buildNotFoundDiagnostics } from '../native/not-found-diagnostics';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-utils';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';
import {
  activateAndClassify,
  createContextMismatchError,
  NativeContextMeta,
} from './native-app-context';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MS = 500;

type WaitCondition = 'exists' | 'not_exists' | 'visible' | 'enabled';

const DEFAULT_SAMPLE_LIMIT = 5;

export interface WaitEvaluation {
  met: boolean;
  matchingCount: number;
  sample: WaitCandidateSample[];
}

export interface WaitCandidateSample {
  role: string;
  label?: string;
  identifier?: string;
  visible?: boolean;
  enabled?: boolean;
  frame?: AXNode['frame'];
  path?: string;
}

export function evaluateWaitCondition(
  matches: AXNode[],
  condition: WaitCondition,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
): WaitEvaluation {
  return {
    met: checkCondition(matches, condition),
    matchingCount: matches.length,
    sample: sampleMatches(matches, sampleLimit),
  };
}

export function hasHeldStableSince(
  conditionMet: boolean,
  firstMetAtMs: number | null,
  nowMs: number,
  stableMs: number,
): { stable: boolean; firstMetAtMs: number | null; stableForMs: number } {
  if (!conditionMet) {
    return { stable: false, firstMetAtMs: null, stableForMs: 0 };
  }
  const nextFirstMetAtMs = firstMetAtMs ?? nowMs;
  const stableForMs = nowMs - nextFirstMetAtMs;
  return {
    stable: stableForMs >= Math.max(0, stableMs),
    firstMetAtMs: nextFirstMetAtMs,
    stableForMs,
  };
}

export function registerAppWaitForNativeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_wait_for',
      description:
        'Wait for a native app UI element matching an accessibility query to appear (or disappear). ' +
        'Polls the accessibility tree until the condition is met or timeout is reached. ' +
        'Essential for waiting after navigation, animations, or async data loading in any app including Flutter.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          identifier: {
            type: 'string',
            description: 'Accessibility identifier to wait for (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label to wait for (case-insensitive substring)',
          },
          text: {
            type: 'string',
            description: 'Text content to wait for in value or label',
          },
          role: {
            type: 'string',
            description: 'Accessibility role to wait for (e.g. "AXButton")',
          },
          condition: {
            type: 'string',
            enum: ['exists', 'not_exists', 'visible', 'enabled'],
            description: 'What condition to wait for (default: "exists")',
          },
          timeout: {
            type: 'number',
            description: 'Max wait time in ms (default: 10000)',
          },
          interval: {
            type: 'number',
            description: 'Poll interval in ms (default: 500)',
          },
          stable_ms: {
            type: 'number',
            description: 'Require the condition to hold continuously for this many ms before success (default: 0).',
          },
          sample_limit: {
            type: 'number',
            description: 'Maximum matching AX nodes to include in timeout diagnostics (default: 5, max: 20).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target app bundle ID. When provided, the tool re-activates the app and rejects mismatched native contexts.',
          },
          scroll_while_waiting: {
            type: 'boolean',
            description:
              'When true, perform a small upward swipe between polls so an off-screen target in a scrollable ancestor is brought into view. Default false to preserve existing behaviour.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const identifier = params.identifier as string | undefined;
      const label = params.label as string | undefined;
      const text = params.text as string | undefined;
      const role = params.role as string | undefined;

      if (!identifier && !label && !text && !role) {
        return respondWithStructuredError(
          ErrorCode.MISSING_REQUIRED_PARAM,
          'At least one query parameter (identifier, label, text, or role) is required',
        );
      }

      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first with device_boot.');
        }

        const condition = (params.condition as WaitCondition | undefined) ?? 'exists';
        const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;
        const interval = (params.interval as number | undefined) ?? DEFAULT_INTERVAL_MS;
        const stableMs = Math.max(0, Math.floor((params.stable_ms as number | undefined) ?? 0));
        const sampleLimit = Math.min(20, Math.max(0, Math.floor((params.sample_limit as number | undefined) ?? DEFAULT_SAMPLE_LIMIT)));
        const bundleId = params.bundle_id as string | undefined;
        const query = { identifier, label, text, role };

        const bridge = getAccessibilityBridge();
        let meta: NativeContextMeta = {
          requestedBundleId: bundleId,
          deviceId,
          sourceKind: 'unknown',
          heuristics: ['not-requested'],
          activationAttempted: false,
          activationRetries: 0,
        };
        let semanticsWarning: string | undefined;
        if (bundleId) {
          const context = await activateAndClassify({
            bridge,
            deviceId,
            bundleId,
            ensureSemanticsActive: () => ensureSemanticsActive(deviceId, { bundleId }),
          });
          meta = context.meta;
          if (meta.sourceKind !== 'target-app') {
            throw createContextMismatchError(meta);
          }
        } else {
          semanticsWarning = (await activateSemanticsOrWarn(deviceId, { bundleId })).warning;
        }
        const startTime = Date.now();
        const deadline = startTime + timeout;
        let pollCount = 0;
        let firstMetAtMs: number | null = null;
        let lastEvaluation: WaitEvaluation = { met: false, matchingCount: 0, sample: [] };
        let lastStableForMs = 0;

        while (Date.now() < deadline) {
          pollCount++;
          try {
            const result = await bridge.query(query, { deviceId });
            lastEvaluation = evaluateWaitCondition(result.matches, condition, sampleLimit);
            const now = Date.now();
            const stable = hasHeldStableSince(lastEvaluation.met, firstMetAtMs, now, stableMs);
            firstMetAtMs = stable.firstMetAtMs;
            lastStableForMs = stable.stableForMs;

            if (stable.stable) {
              const elapsed = now - startTime;
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'found',
                    condition,
                    elapsed,
                    polls: pollCount,
                    stable_ms: stableMs,
                    stable_for_ms: lastStableForMs,
                    matching_count: lastEvaluation.matchingCount,
                    element: condition !== 'not_exists' && result.matches.length > 0
                      ? {
                        role: result.matches[0].role,
                        label: result.matches[0].label,
                        identifier: result.matches[0].identifier,
                        frame: result.matches[0].frame,
                        path: result.matches[0].path,
                      }
                      : null,
                    _meta: { context: meta },
                  }),
                }],
              };
            }
          } catch {
            // Query error during polling breaks any requested stability window;
            // a condition cannot be considered continuously held across an
            // interval where it was not observed.
            firstMetAtMs = null;
            lastStableForMs = 0;
            lastEvaluation = { met: false, matchingCount: 0, sample: [] };
          }

          // Don't sleep past deadline
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;

          // Optionally scroll the viewport between polls so an off-screen
          // target in a scrollable ancestor (ListView, infinite list, etc.)
          // is gradually brought into view instead of being timed out
          // before it ever paints. Best-effort: a failed swipe doesn't
          // break the wait loop.
          if (params.scroll_while_waiting === true) {
            try {
              const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
              await backend.swipe(deviceId, 200, 600, 200, 200, 0.2);
            } catch {
              // ignore — wait loop continues without scrolling
            }
          }

          await sleep(Math.min(interval, remaining));
        }

        // Timeout
        const elapsed = Date.now() - startTime;
        // For "wait until it appears" conditions, attach a bounded snapshot of
        // what IS on screen so the timeout is diagnosable in one call instead
        // of a manual app_tree round-trip (#834). Skipped for not_exists, where
        // a timeout means the element is still present (nothing to surface).
        const diagnostics =
          condition === 'not_exists'
            ? undefined
            : await buildNotFoundDiagnostics(bridge, deviceId, query);
        return respondWithStructuredError(
          ErrorCode.APP_STATE_UNKNOWN,
          'Timeout waiting for element',
          { condition, query, timeout, elapsed, polls: pollCount, semanticsWarning, diagnostics },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_wait_for] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}

function sampleMatches(matches: AXNode[], limit: number): WaitCandidateSample[] {
  return matches.slice(0, limit).map((m) => ({
    role: m.role,
    ...(m.label ? { label: m.label } : {}),
    ...(m.identifier ? { identifier: m.identifier } : {}),
    visible: m.visible,
    enabled: m.enabled,
    frame: m.frame,
    path: m.path,
  }));
}

function checkCondition(matches: AXNode[], condition: WaitCondition): boolean {
  switch (condition) {
    case 'exists':
      return matches.length > 0;
    case 'not_exists':
      return matches.length === 0;
    case 'visible':
      return matches.some((m) => m.visible);
    case 'enabled':
      return matches.some((m) => m.enabled);
    default:
      return matches.length > 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
