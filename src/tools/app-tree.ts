import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import { dumpTreeWithRecovery } from '../native/ax-bridge-recovery';
import { getSessionManager } from '../session-manager';
import {
  createContextMismatchError,
  ensureTargetAppContext,
} from './native-app-context';
import { AccessibilityBridgeError } from '../native/accessibility-bridge';
import { DEVICE_CONTENT_ROOT_EMPTY } from '../native/ax-bridge-content-root';

const APP_TREE_RETRY_COUNT = 3;
const APP_TREE_RETRY_BACKOFF_MS = [250, 500, 1000] as const;

/**
 * Calls `bridge.dumpTree(options)` and retries with backoff on
 * `DEVICE_CONTENT_ROOT_EMPTY`. The empty-root condition is observed
 * transiently after a system alert is dismissed (issue #639 Problem 4a) —
 * iOS takes a beat to repopulate the AX root for the foreground app, and
 * before that beat the bridge sees zero app-semantics nodes and reports
 * the structured empty-root error. Re-querying after a short backoff
 * almost always succeeds; only persistent empty-root after `maxRetries`
 * surfaces as an error.
 *
 * Other bridge errors are re-thrown immediately without retry.
 *
 * Exported so unit tests can assert the retry contract without driving
 * a live simulator.
 */
export async function dumpTreeWithRetry(
  bridge: { dumpTree: (opts: { deviceId?: string; maxDepth?: number }) => Promise<unknown> },
  options: { deviceId?: string; maxDepth?: number },
  maxRetries = APP_TREE_RETRY_COUNT,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((r) => setTimeout(r, ms)),
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await bridge.dumpTree(options);
    } catch (err) {
      lastError = err;
      const isEmptyRoot =
        err instanceof AccessibilityBridgeError &&
        err.code === DEVICE_CONTENT_ROOT_EMPTY;
      if (!isEmptyRoot || attempt >= maxRetries) throw err;
      await sleep(APP_TREE_RETRY_BACKOFF_MS[attempt] ?? 1000);
    }
  }
  throw lastError;
}

export function registerAppTreeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_tree',
      description: 'Dump the native accessibility tree of the foreground app in iOS Simulator. Returns a structured JSON snapshot of the UI hierarchy including roles, labels, identifiers, traits, frames, and visibility state. Compatible with Flutter apps — the tool auto-activates Flutter\'s lazy Semantics tree before reading so widget labels/text appear as accessibility nodes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator device UDID (defaults to active device)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target Flutter app bundle ID. Used to disambiguate Dart VM Service discovery when multiple Flutter apps run on the same simulator — the macOS AX bridge itself always reads the current foreground app.',
          },
          max_depth: {
            type: 'number',
            description: 'Maximum tree depth to traverse (default: 10)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = (params.device_id as string) ?? getSessionManager().getSoleDeviceId() ?? undefined;
        const bundleId = params.bundle_id as string | undefined;
        const maxDepth = params.max_depth as number | undefined;

        const bridge = getAccessibilityBridge();
        let tree;
        let meta;
        if (bundleId) {
          const context = await ensureTargetAppContext({
            bridge,
            deviceId,
            bundleId,
            maxDepth,
            ensureSemanticsActive: () => ensureSemanticsActive(deviceId, { bundleId }),
          });
          tree = context.tree;
          meta = context.meta;
          if (meta.sourceKind !== 'target-app') {
            throw createContextMismatchError(meta);
          }
        } else {
          await ensureSemanticsActive(deviceId, { bundleId });
          const dump = await dumpTreeWithRecovery(bridge, {
            deviceId,
            maxDepth,
            bundleId,
            backoffMs: [...APP_TREE_RETRY_BACKOFF_MS],
          });
          tree = dump.tree;
          meta = {
            requestedBundleId: undefined,
            deviceId: deviceId ?? '',
            sourceKind: 'unknown' as const,
            heuristics: ['not-requested'],
            activationAttempted: false,
            activationRetries: 0,
            axBridgeRecovery: dump.recovery,
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...tree,
              _meta: { context: meta },
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
