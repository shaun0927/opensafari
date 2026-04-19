/**
 * app_tap — Tap on native UI elements at specific coordinates.
 *
 * Uses `xcrun simctl io <device> input tap` to send touch events directly
 * to the Simulator, bypassing WebKit entirely. Works with any app, not
 * just Safari.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge } from '../native/accessibility-bridge';
import { ensureSemanticsActive, countNodes } from '../native/semantics-activator';
import type { AXNode } from '../native/ax-types';
import { walkTree, fingerprintTree } from '../native/ax-verification';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';
import { probeMobileContext } from './app-context';
import { SimulatorManager } from '../simulator';

type CoordinateTapVerification = {
  verified: boolean;
  effect: 'subtree_changed' | 'no_observable_change' | 'verification_unavailable';
};

export function registerAppTapTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_tap',
      description:
        'Tap at screen coordinates in the iOS Simulator (works with any app, not just Safari)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          x: { type: 'number', description: 'X coordinate to tap' },
          y: { type: 'number', description: 'Y coordinate to tap' },
          expectedBundle: {
            type: 'string',
            description:
              'Optional bundle identifier expected to remain foreground after the tap settles.',
          },
          verifyContext: {
            type: 'boolean',
            description:
              'When true, run a post-tap context probe and include it in the response.',
          },
          settleMs: {
            type: 'number',
            description:
              'Milliseconds to wait before probing the post-tap context (default: 1200).',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          duration: {
            type: 'number',
            description:
              'Tap duration in seconds for long press (default: 0 for normal tap)',
          },
        },
        required: ['x', 'y'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const x = params.x as number;
        const y = params.y as number;
        const duration = (params.duration as number | undefined) ?? 0;
        const expectedBundle = params.expectedBundle as string | undefined;
        const verifyContext =
          params.verifyContext === true || typeof expectedBundle === 'string';
        const settleMs = (params.settleMs as number | undefined) ?? 1200;

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'x and y must be finite numbers' }),
              },
            ],
            isError: true,
          };
        }

        const bridge = getAccessibilityBridge();
        let beforeTree: AXNode | null = null;
        let semanticsActive = false;
        try {
          semanticsActive = await ensureSemanticsActive(deviceId);
          if (semanticsActive) {
            beforeTree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
            // If the tree is suspiciously sparse after activation, treat
            // verification as unavailable to avoid false TAP_NO_EFFECT on
            // Flutter screens where semantics are still materialising.
            if (beforeTree !== null && countNodes(beforeTree) < 5) {
              beforeTree = null;
            }
          }
        } catch {
          beforeTree = null;
        }

        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.tap(deviceId, x, y, duration > 0 ? duration : undefined),
        );

        const verification = await verifyCoordinateTapEffect(bridge, deviceId, beforeTree);

        if (verification.effect === 'verification_unavailable') {
          const manager = new SimulatorManager();
          let postInputContext;
          let warning: string | undefined;
          if (verifyContext) {
            await new Promise((resolve) => setTimeout(resolve, settleMs));
            try {
              const probe = await probeMobileContext({ deviceId, expectedBundle, manager });
              postInputContext = probe;
              if (expectedBundle && probe.expectedBundleMatch !== 'matched') {
                warning = JSON.stringify({
                  code: 'POST_TAP_CONTEXT_MISMATCH',
                  message:
                    `Post-tap context did not confirm expected bundle ${expectedBundle}. ` +
                    `surface=${probe.surface}, match=${probe.expectedBundleMatch ?? 'unknown'}.`,
                  context: probe,
                });
              }
            } catch (probeErr) {
              const reason = probeErr instanceof Error ? probeErr.message : String(probeErr);
              console.error(`[app_tap] post-tap context probe failed: ${reason}`);
              warning = JSON.stringify({
                code: 'POST_TAP_CONTEXT_PROBE_FAILED',
                message: 'Post-tap context probe failed.',
                reason,
              });
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'tapped',
                  x,
                  y,
                  duration,
                  deviceId,
                  backend: backend.kind,
                  verified: false,
                  effect: verification.effect,
                  warning:
                    warning ??
                    'The tap was dispatched but post-action AX verification was unavailable.',
                  _meta: meta,
                  postInputContext,
                }),
              },
            ],
          };
        }

        if (!verification.verified) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'TAP_NO_EFFECT',
                  message:
                    'The tap was dispatched successfully, but no observable AX tree change was detected afterward.',
                  x,
                  y,
                  duration,
                  deviceId,
                  backend: backend.kind,
                  verified: false,
                  effect: verification.effect,
                  _meta: meta,
                }),
              },
            ],
            isError: true,
          };
        }

        const manager = new SimulatorManager();
        let postInputContext;
        let warning: string | undefined;
        if (verifyContext) {
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          try {
            const probe = await probeMobileContext({ deviceId, expectedBundle, manager });
            postInputContext = probe;
            if (expectedBundle && probe.expectedBundleMatch !== 'matched') {
              warning = JSON.stringify({
                code: 'POST_TAP_CONTEXT_MISMATCH',
                message:
                  `Post-tap context did not confirm expected bundle ${expectedBundle}. ` +
                  `surface=${probe.surface}, match=${probe.expectedBundleMatch ?? 'unknown'}.`,
                context: probe,
              });
            }
          } catch (probeErr) {
            const reason = probeErr instanceof Error ? probeErr.message : String(probeErr);
            console.error(`[app_tap] post-tap context probe failed: ${reason}`);
            warning = JSON.stringify({
              code: 'POST_TAP_CONTEXT_PROBE_FAILED',
              message: 'Post-tap context probe failed.',
              reason,
            });
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'tapped',
                x,
                y,
                duration,
                deviceId,
                backend: backend.kind,
                verified: true,
                effect: verification.effect,
                _meta: meta,
                postInputContext,
                warning,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_tap] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

const VERIFY_POLL_INTERVAL_MS = 150;
const VERIFY_POLL_TIMEOUT_MS = 1200;

async function verifyCoordinateTapEffect(
  bridge: ReturnType<typeof getAccessibilityBridge>,
  deviceId: string,
  beforeTree: AXNode | null,
): Promise<CoordinateTapVerification> {
  if (!beforeTree) {
    return { verified: false, effect: 'verification_unavailable' };
  }

  const beforeFingerprint = fingerprintTree(beforeTree);
  const deadline = Date.now() + VERIFY_POLL_TIMEOUT_MS;
  const maxIterations = Math.ceil(VERIFY_POLL_TIMEOUT_MS / VERIFY_POLL_INTERVAL_MS) + 1;
  let iteration = 0;

  try {
    while (Date.now() < deadline && iteration < maxIterations) {
      iteration++;
      await new Promise<void>((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
      const afterTree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
      if (beforeFingerprint !== fingerprintTree(afterTree)) {
        return { verified: true, effect: 'subtree_changed' };
      }
    }
    return { verified: false, effect: 'no_observable_change' };
  } catch {
    return { verified: false, effect: 'verification_unavailable' };
  }
}
