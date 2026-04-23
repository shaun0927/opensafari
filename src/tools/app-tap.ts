/**
 * app_tap — Tap on native UI elements at specific coordinates.
 *
 * Uses `xcrun simctl io <device> input tap` to send touch events directly
 * to the Simulator, bypassing WebKit entirely. Works with any app, not
 * just Safari.
 *
 * Issue #644 safety layer:
 *   * Raw coordinate taps are bounds-checked against the device frame and
 *     the bottom home-indicator guard band. Out-of-range taps are rejected
 *     instead of silently dispatched (raw taps near the bottom edge tend
 *     to be reinterpreted as home-gesture swipes, which drops the calling
 *     app into the background and exposes SpringBoard).
 *   * When a modal (AXSheet / AXDialog / AXAlert) is in the pre-tap AX
 *     tree, `app_tap` snaps the coordinate to the nearest enabled button
 *     frame and calls the AX press path instead of forwarding the raw
 *     coordinate. Callers can opt out with `raw: true`.
 *   * After the tap, `app_tap` classifies the pre/post AX trees. If the
 *     app left the foreground (SpringBoard / simulator chrome visible),
 *     the response carries `sideEffect: "app_backgrounded"` and, when
 *     `autoReactivate` is on, re-foregrounds the expected bundle.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge } from '../native/accessibility-bridge';
import { ensureSemanticsActive, countNodes } from '../native/semantics-activator';
import type { AXNode } from '../native/ax-types';
import { fingerprintTree } from '../native/ax-verification';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';
import { probeMobileContext } from './app-context';
import { SimulatorManager } from '../simulator';
import { classifyNativeContext } from './native-app-context';
import {
  DEFAULT_HOME_INDICATOR_GUARD_PX,
  frameFromAXRoot,
  validateRawTapBounds,
  type DeviceFrame,
} from './tap-bounds';

type CoordinateTapVerification = {
  verified: boolean;
  effect: 'subtree_changed' | 'no_observable_change' | 'verification_unavailable';
  afterTree: AXNode | null;
};

type TapSideEffect =
  | 'none'
  | 'app_backgrounded'
  | 'coordinate_clamped'
  | 'ax_snapped'
  | 'out_of_bounds';

const MODAL_ROLES = new Set([
  'AXSheet',
  'AXDialog',
  'AXAlert',
  'AXSystemDialog',
]);

const DEFAULT_SNAP_RADIUS_PX = 24;

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
          raw: {
            type: 'boolean',
            description:
              'When true, dispatch the raw coordinate without AX-aware snapping. ' +
              'Defaults to false; callers that intentionally target a coordinate ' +
              '(e.g. an unlabeled region) should opt in explicitly.',
          },
          requireInApp: {
            type: 'boolean',
            description:
              'When true (default), treat a tap that drops the app into the ' +
              'background as a soft failure (sideEffect: "app_backgrounded", ' +
              'ok: false). When false, the side effect is still reported but ' +
              'the tap is considered successful.',
          },
          autoReactivate: {
            type: 'boolean',
            description:
              'When true and the tap backgrounds the app, call simctl activate ' +
              'on expectedBundle (or the inferred bundle) before returning. ' +
              'Defaults to false.',
          },
          snapRadiusPx: {
            type: 'number',
            description:
              'Maximum distance (px) between the input coordinate and a candidate ' +
              'AXButton centre for the AX snap path. Default 24.',
          },
          homeIndicatorGuardPx: {
            type: 'number',
            description:
              'Height (px) of the bottom home-indicator guard band that rejects ' +
              'raw taps to prevent home-gesture misinterpretation. Default 10.',
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
        const raw = params.raw === true;
        const requireInApp = params.requireInApp !== false; // default true
        const autoReactivate = params.autoReactivate === true;
        const snapRadiusPx =
          (params.snapRadiusPx as number | undefined) ?? DEFAULT_SNAP_RADIUS_PX;
        const homeIndicatorGuardPx =
          (params.homeIndicatorGuardPx as number | undefined) ??
          DEFAULT_HOME_INDICATOR_GUARD_PX;

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

        const foregroundBefore = beforeTree
          ? classifyNativeContext(beforeTree).sourceKind
          : 'unknown';

        // Device-frame guard (#644 WU2) — only applied to raw coordinate
        // dispatches. AX snap (WU4) overrides the raw coordinate with a
        // button centre, so it is safe by construction.
        const deviceFrame = resolveDeviceFrame(beforeTree);
        let boundsRejection: { reason: string; detail: string } | null = null;
        if (deviceFrame) {
          const guard = validateRawTapBounds({
            x,
            y,
            frame: deviceFrame,
            homeIndicatorGuardPx,
          });
          if (!guard.ok) {
            boundsRejection = { reason: guard.reason, detail: guard.detail };
          }
        }

        // AX snap (#644 WU4) — when a modal is showing and the caller did
        // not opt out with raw=true, snap to the closest enabled AXButton.
        let snap: AXSnapResult | null = null;
        if (!raw && beforeTree) {
          snap = tryAXSnap(beforeTree, x, y, snapRadiusPx);
        }

        // If the raw path would be out of bounds but we successfully snapped
        // to an AX button, prefer the snap path.
        if (boundsRejection && !snap) {
          return buildOutOfBoundsResponse({
            x,
            y,
            deviceId,
            boundsRejection,
            deviceFrame,
            foregroundBefore,
          });
        }

        // Resolve the effective coordinate: AX snap centre or raw.
        const effectiveX = snap ? snap.x : x;
        const effectiveY = snap ? snap.y : y;

        let axPressOk = false;
        let axPressActions: string[] | undefined;
        if (snap && duration === 0) {
          try {
            const pressResp = await bridge.press(snap.elementPath, deviceId);
            if (pressResp?.ok) {
              axPressOk = true;
              axPressActions = pressResp.actions;
            } else {
              // Snap target was not actionable; fall back to dispatching the
              // snapped centre coordinate through the normal backend path.
              console.error(
                `[app_tap] AX snap found ${snap.elementPath} but press was ` +
                  `not actionable (code=${pressResp?.code ?? 'unknown'}); ` +
                  `dispatching snapped coordinate instead.`,
              );
            }
          } catch (pressErr) {
            const msg = pressErr instanceof Error ? pressErr.message : String(pressErr);
            console.error(
              `[app_tap] AX press failed for snapped target ${snap.elementPath}; ` +
                `falling back to coordinate dispatch. Reason: ${msg}`,
            );
          }
        }

        let backendKind: string;
        let meta: Record<string, unknown>;
        if (axPressOk) {
          backendKind = 'ax-press';
          meta = { backendKind: 'ax-press', headless: true, deviceId };
          if (axPressActions) meta.axActions = axPressActions;
        } else {
          const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
          const op = await runInputOp(backend, deviceId, () =>
            backend.tap(deviceId, effectiveX, effectiveY, duration > 0 ? duration : undefined),
          );
          backendKind = backend.kind;
          meta = { ...(op.meta as unknown as Record<string, unknown>) };
        }

        const verification = await verifyCoordinateTapEffect(
          bridge,
          deviceId,
          beforeTree,
        );

        const foregroundAfter = verification.afterTree
          ? classifyNativeContext(verification.afterTree).sourceKind
          : 'unknown';

        let sideEffect: TapSideEffect = 'none';
        if (snap) sideEffect = 'ax_snapped';
        // Background detection (WU3). Only fire when we had a confident
        // before-state classification — otherwise we cannot say the tap
        // caused the transition.
        const appBackgrounded =
          foregroundBefore === 'target-app' &&
          (foregroundAfter === 'springboard' ||
            foregroundAfter === 'simulator-window');
        if (appBackgrounded) sideEffect = 'app_backgrounded';

        // autoReactivate (WU5).
        let recovered = false;
        if (appBackgrounded && autoReactivate) {
          const bundleToRecover = expectedBundle;
          if (bundleToRecover) {
            try {
              const manager = new SimulatorManager();
              await manager.activateApp(deviceId, bundleToRecover);
              recovered = true;
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              console.error(
                `[app_tap] autoReactivate failed for ${bundleToRecover}: ${reason}`,
              );
            }
          } else {
            console.error(
              '[app_tap] autoReactivate requested but expectedBundle was not provided; skipping recovery.',
            );
          }
        }

        // Post-tap context probe (existing behaviour preserved).
        const manager = new SimulatorManager();
        let postInputContext;
        let warning: string | undefined;
        if (verification.effect === 'verification_unavailable' && verifyContext) {
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
        } else if (verifyContext) {
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

        const base: Record<string, unknown> = {
          status: 'tapped',
          x,
          y,
          duration,
          deviceId,
          backend: backendKind,
          effect: verification.effect,
          sideEffect,
          foregroundBefore,
          foregroundAfter,
          _meta: meta,
        };
        if (snap) {
          base.snapped = {
            from: { x, y },
            to: { x: effectiveX, y: effectiveY },
            elementPath: snap.elementPath,
            via: axPressOk ? 'ax-press' : 'coordinate',
          };
        }
        if (postInputContext) base.postInputContext = postInputContext;

        // Branch on verification + side effects.
        if (verification.effect === 'verification_unavailable') {
          base.verified = false;
          base.warning =
            warning ??
            'The tap was dispatched but post-action AX verification was unavailable.';
          if (appBackgrounded && requireInApp) {
            return buildBackgroundedResponse(base, { recovered, expectedBundle });
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(base) }],
          };
        }

        if (appBackgrounded && requireInApp) {
          base.verified = verification.verified;
          return buildBackgroundedResponse(base, { recovered, expectedBundle });
        }

        if (!verification.verified) {
          base.verified = false;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ...base,
                  error: 'TAP_NO_EFFECT',
                  message:
                    'The tap was dispatched successfully, but no observable AX tree change was detected afterward.',
                }),
              },
            ],
            isError: true,
          };
        }

        base.verified = true;
        if (warning) base.warning = warning;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(base) }],
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

function buildOutOfBoundsResponse(args: {
  x: number;
  y: number;
  deviceId: string;
  boundsRejection: { reason: string; detail: string };
  deviceFrame: DeviceFrame | null;
  foregroundBefore: string;
}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'TAP_OUT_OF_BOUNDS',
          message: args.boundsRejection.detail,
          sideEffect: 'out_of_bounds',
          reason: args.boundsRejection.reason,
          x: args.x,
          y: args.y,
          deviceId: args.deviceId,
          deviceFrame: args.deviceFrame,
          foregroundBefore: args.foregroundBefore,
          verified: false,
          dispatched: false,
        }),
      },
    ],
    isError: true,
  };
}

function buildBackgroundedResponse(
  base: Record<string, unknown>,
  args: { recovered: boolean; expectedBundle?: string },
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...base,
          error: 'APP_BACKGROUNDED',
          message:
            'The tap dispatched successfully but the app left the foreground (SpringBoard or simulator chrome is now visible). ' +
            'This usually means the coordinate was interpreted as a home-gesture swipe.',
          recovered: args.recovered,
          ...(args.expectedBundle ? { expectedBundle: args.expectedBundle } : {}),
        }),
      },
    ],
    isError: true,
  };
}

function resolveDeviceFrame(tree: AXNode | null): DeviceFrame | null {
  return frameFromAXRoot(tree);
}

interface AXSnapResult {
  x: number;
  y: number;
  elementPath: string;
  distance: number;
}

/**
 * When a modal (AXSheet / AXDialog / AXAlert) is present in the AX tree,
 * pick the enabled AXButton whose centre is closest to the input
 * coordinate within `snapRadiusPx`.
 */
function tryAXSnap(
  tree: AXNode,
  x: number,
  y: number,
  snapRadiusPx: number,
): AXSnapResult | null {
  const modals: AXNode[] = [];
  collectNodes(tree, (node) => {
    if (MODAL_ROLES.has(node.role) && node.visible) modals.push(node);
  });
  if (modals.length === 0) return null;

  let best: AXSnapResult | null = null;
  for (const modal of modals) {
    collectNodes(modal, (node) => {
      if (!node.visible || !node.enabled) return;
      if (node.role !== 'AXButton') return;
      if (node.frame.width <= 0 || node.frame.height <= 0) return;
      const cx = node.frame.x + node.frame.width / 2;
      const cy = node.frame.y + node.frame.height / 2;
      const distance = Math.hypot(cx - x, cy - y);
      if (distance > snapRadiusPx) return;
      if (!best || distance < best.distance) {
        best = { x: cx, y: cy, elementPath: node.path, distance };
      }
    });
  }
  return best;
}

function collectNodes(root: AXNode, visit: (node: AXNode) => void): void {
  visit(root);
  for (const child of root.children ?? []) {
    collectNodes(child, visit);
  }
}

const VERIFY_POLL_INTERVAL_MS = 150;
const VERIFY_POLL_TIMEOUT_MS = 1200;

async function verifyCoordinateTapEffect(
  bridge: ReturnType<typeof getAccessibilityBridge>,
  deviceId: string,
  beforeTree: AXNode | null,
): Promise<CoordinateTapVerification> {
  if (!beforeTree) {
    return { verified: false, effect: 'verification_unavailable', afterTree: null };
  }

  const beforeFingerprint = fingerprintTree(beforeTree);
  const deadline = Date.now() + VERIFY_POLL_TIMEOUT_MS;
  const maxIterations = Math.ceil(VERIFY_POLL_TIMEOUT_MS / VERIFY_POLL_INTERVAL_MS) + 1;
  let iteration = 0;
  let lastAfterTree: AXNode | null = null;

  try {
    while (Date.now() < deadline && iteration < maxIterations) {
      iteration++;
      await new Promise<void>((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
      const afterTree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
      lastAfterTree = afterTree;
      if (beforeFingerprint !== fingerprintTree(afterTree)) {
        return { verified: true, effect: 'subtree_changed', afterTree };
      }
    }
    return { verified: false, effect: 'no_observable_change', afterTree: lastAfterTree };
  } catch {
    return { verified: false, effect: 'verification_unavailable', afterTree: lastAfterTree };
  }
}
