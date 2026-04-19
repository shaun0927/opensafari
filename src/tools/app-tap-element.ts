/**
 * app_tap_element — Tap a native UI element by accessibility query.
 *
 * Combines app_query (find element) + frame center calculation + app_tap
 * (send touch) into a single semantic action. Works with any app including
 * Flutter — no WebKit/DOM required.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive, countNodes } from '../native';
import type { AXNode, AXPressResponse } from '../native';
import type { AccessibilityBridge } from '../native/accessibility-bridge';
import { walkTree, fingerprintTree } from '../native/ax-verification';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';
import { probeMobileContext } from './app-context';
import {
  activateAndClassify,
  createContextMismatchError,
  NativeContextMeta,
} from './native-app-context';
import { SimulatorManager } from '../simulator';

type AXPressVerification = {
  verified: boolean;
  effect:
    | 'target_disappeared'
    | 'target_appeared'
    | 'focus_changed'
    | 'subtree_changed'
    | 'no_observable_change'
    | 'verification_unavailable';
};

type CoordinateTapVerification = {
  verified: boolean;
  effect: 'subtree_changed' | 'no_observable_change' | 'verification_unavailable';
};

export function registerAppTapElementTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_tap_element',
      description:
        'Tap a native app UI element by accessibility query (label, identifier, role, or text). ' +
        'Finds the element in the accessibility tree, calculates its center coordinates, and taps it. ' +
        'Works with any app including Flutter — no WebKit/DOM required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          identifier: {
            type: 'string',
            description: 'Accessibility identifier (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label (case-insensitive substring)',
          },
          text: {
            type: 'string',
            description: 'Text content in value or label (case-insensitive substring)',
          },
          role: {
            type: 'string',
            description: 'Accessibility role (e.g. "AXButton", "AXStaticText")',
          },
          index: {
            type: 'number',
            description: 'Which match to tap when multiple found (0-based, default: 0)',
          },
          timeout: {
            type: 'number',
            description: 'Max ms to wait for element to appear (default: 5000). Set to 0 to skip waiting.',
          },
          duration: {
            type: 'number',
            description: 'Tap duration in seconds for long press (default: 0 for normal tap)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target app bundle ID. When provided, the tool re-activates the app and rejects mismatched native contexts.',
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'At least one query parameter (identifier, label, text, or role) is required',
            }),
          }],
          isError: true,
        };
      }

      try {
        const deviceId = resolveDeviceId(params);
        const indexProvided = typeof params.index === 'number';
        const index = (params.index as number | undefined) ?? 0;
        const timeout = (params.timeout as number | undefined) ?? 5000;
        const duration = (params.duration as number | undefined) ?? 0;
        const bundleId = params.bundle_id as string | undefined;

        const bridge = getAccessibilityBridge();
        let contextMeta: NativeContextMeta = {
          requestedBundleId: bundleId,
          deviceId,
          sourceKind: 'unknown',
          heuristics: ['not-requested'],
          activationAttempted: false,
          activationRetries: 0,
        };
        if (bundleId) {
          const context = await activateAndClassify({
            bridge,
            deviceId,
            bundleId,
            ensureSemanticsActive: () => ensureSemanticsActive(deviceId, { bundleId }),
          });
          contextMeta = context.meta;
          if (contextMeta.sourceKind !== 'target-app') {
            throw createContextMismatchError(contextMeta);
          }
        } else {
          await ensureSemanticsActive(deviceId, { bundleId });
        }
        const query = { identifier, label, text, role };

        // Wait for element to appear (with timeout). We also track the
        // total number of matches and the bridge's ambiguity flag so the
        // caller can tell when a single match was expected but several
        // candidates existed.
        let match: AXNode | undefined;
        let totalMatches = 0;
        let ambiguous = false;
        if (timeout > 0) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const result = await bridge.query(query, { deviceId });
            totalMatches = result.matches.length;
            ambiguous = result.ambiguous;
            if (result.matches.length > index) {
              match = result.matches[index];
              break;
            }
            await sleep(300);
          }
        } else {
          const result = await bridge.query(query, { deviceId });
          totalMatches = result.matches.length;
          ambiguous = result.ambiguous;
          if (result.matches.length > index) {
            match = result.matches[index];
          }
        }

        if (!match) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Element not found',
                query,
                index,
                timeout,
                _meta: { context: contextMeta },
              }),
            }],
            isError: true,
          };
        }

        // Validate element is visible and has nonzero size
        if (!match.visible || match.frame.width <= 0 || match.frame.height <= 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Element found but not visible or has zero size',
                element: {
                  role: match.role,
                  label: match.label,
                  identifier: match.identifier,
                  frame: match.frame,
                  visible: match.visible,
                },
              }),
            }],
            isError: true,
          };
        }

        // Calculate center of element
        const rawCenterX = match.frame.x + match.frame.width / 2;
        const rawCenterY = match.frame.y + match.frame.height / 2;

        // Sanitize the tap target. An accessibility tree that reports a
        // `visible: true` element with a frame whose center lands outside
        // the device coordinate plane has already given us broken data;
        // the tool still tries to rescue the tap by clamping to the
        // nearest non-negative coordinate so edge-aligned elements remain
        // tappable, but it refuses to forward NaN / Infinity which cannot
        // be interpreted by any input backend.
        let centerX: number;
        let centerY: number;
        let clampedFrom: { x: number; y: number } | undefined;
        try {
          ({ x: centerX, y: centerY, clampedFrom } = sanitizeTapTarget(rawCenterX, rawCenterY));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                element: {
                  role: match.role,
                  label: match.label,
                  identifier: match.identifier,
                  frame: match.frame,
                },
              }),
            }],
            isError: true,
          };
        }

        if (clampedFrom) {
          console.error(
            `[app_tap_element] tap coordinates (${clampedFrom.x}, ${clampedFrom.y}) fell outside the ` +
              `device coordinate plane; clamped to (${centerX}, ${centerY}). ` +
              `This usually indicates a stale or misreported accessibility frame.`,
          );
        }

        let coordinateVerificationBaseline: AXNode | null = null;

        // Tier 1.5 — AX press: drive interaction through the macOS AX API
        // instead of synthesising OS-level input. Works on every Xcode
        // version (including Xcode 26+ where SimHID tap/swipe is disabled
        // by #537) and never moves the user's mouse. Only applicable for
        // simple taps — long-press (`duration > 0`) still flows through
        // the coordinate-based backend chain below because AXPress has no
        // duration semantics.
        const axPressDisabled =
          process.env.OPENSAFARI_DISABLE_AX_PRESS === '1' ||
          process.env.OPENSAFARI_DISABLE_AX_PRESS === 'true';
        if (duration === 0 && match.path && !axPressDisabled) {
          const pressResponse = await tryPress(bridge, match.path, deviceId);
          if (pressResponse?.ok) {
            // Dump the pre-press snapshot only after we know the press succeeded —
            // this avoids a wasted round-trip on PRESS_NOT_ACTIONABLE / PRESS_FAILED.
            let beforeTree: AXNode | null = null;
            try {
              beforeTree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
            } catch (dumpErr) {
              const dumpMsg = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
              console.error(
                `[app_tap_element] pre-press AX tree dump failed; verification will be skipped. Reason: ${dumpMsg}`,
              );
            }
            await sleep(250);
            let afterTree: AXNode | null = null;
            try {
              afterTree = await bridge.dumpTree({ deviceId, maxDepth: 8 });
            } catch (dumpErr) {
              const dumpMsg = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
              console.error(
                `[app_tap_element] post-press AX tree dump failed; verification will be skipped. Reason: ${dumpMsg}`,
              );
            }
            const verification =
              beforeTree !== null && afterTree !== null
                ? verifyAXPressEffect(beforeTree, afterTree, match)
                : { verified: false, effect: 'verification_unavailable' as const };
            if (verification.verified) {
              const response = buildAXPressResponse({
                match,
                centerX,
                centerY,
                deviceId,
                totalMatches,
                indexProvided,
                index,
                ambiguous,
                clampedFrom,
                pressActions: pressResponse.actions,
                effect: verification.effect,
              });
              response._meta = {
                ...(response._meta as Record<string, unknown>),
                context: contextMeta,
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(response) }],
              };
            }

            console.error(
              `[app_tap_element] AXPress returned OK for path ${match.path} ` +
                `but no observable UI effect was detected (${verification.effect}); ` +
                `falling back to coordinate tap.`,
            );
            coordinateVerificationBaseline =
              beforeTree !== null && countNodes(beforeTree) >= 5 ? beforeTree : null;
          }
          if (pressResponse && pressResponse.code === 'PRESS_NOT_ACTIONABLE') {
            console.error(
              `[app_tap_element] AX press not actionable for path ${match.path} ` +
                `(role=${match.role}, id=${match.identifier ?? '-'}, ` +
                `actions=${JSON.stringify(pressResponse.actions)}); ` +
                `falling back to coordinate tap.`,
            );
          } else if (pressResponse && pressResponse.code === 'PRESS_FAILED') {
            console.error(
              `[app_tap_element] AXPress action fired but returned non-success ` +
                `(axErrorCode=${pressResponse.axErrorCode}, path=${match.path}); ` +
                `falling back to coordinate tap.`,
            );
          }
        }

        if (bundleId && coordinateVerificationBaseline === null) {
          try {
            await ensureSemanticsActive(deviceId, { bundleId });
            const baseline = await bridge.dumpTree({ deviceId, maxDepth: 8 });
            coordinateVerificationBaseline = countNodes(baseline) >= 5 ? baseline : null;
          } catch (dumpErr) {
            const dumpMsg = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
            console.error(
              `[app_tap_element] pre-coordinate AX tree dump failed; verification will be skipped. Reason: ${dumpMsg}`,
            );
          }
        }

        // Tap via input backend
        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.tap(deviceId, centerX, centerY, duration > 0 ? duration : undefined),
        );
        const shouldVerifyCoordinateTap = bundleId || coordinateVerificationBaseline !== null;
        const verification = shouldVerifyCoordinateTap
          ? await verifyCoordinateTapEffect(
            bridge,
            deviceId,
            coordinateVerificationBaseline,
          )
          : undefined;
        const postInputContext = bundleId
          ? await probePostInputContext({ deviceId, expectedBundle: bundleId })
          : undefined;

        // Flag an implicit ambiguous tap: several candidates matched but
        // the caller did not disambiguate via `index`. We still tap the
        // first match (prior behavior) but surface a warning so the
        // caller can tighten the query or pass an explicit index.
        const implicitAmbiguity = !indexProvided && (ambiguous || totalMatches > 1);

        if (implicitAmbiguity) {
          console.error(
            `[app_tap_element] ambiguous query matched ${totalMatches} elements; tapping index ${index}. ` +
              `Pass a narrower query or an explicit index to silence this warning.`,
          );
        }

        const response: Record<string, unknown> = {
          status: 'tapped',
          element: {
            role: match.role,
            label: match.label,
            identifier: match.identifier,
            path: match.path,
          },
          coordinates: { x: centerX, y: centerY },
          backend: backend.kind,
          deviceId,
          totalMatches,
          _meta: {
            ...meta,
            context: contextMeta,
          },
        };
        if (verification) {
          response.verified = verification.verified;
          response.effect = verification.effect;
        }
        if (postInputContext) {
          response.postInputContext = postInputContext.probe;
        }
        if (clampedFrom) {
          response.clampedFrom = clampedFrom;
        }
        const warnings: string[] = [];
        if (clampedFrom) {
          warnings.push(
            `tap coordinates clamped to screen bounds from (${clampedFrom.x}, ${clampedFrom.y})`,
          );
        }
        if (implicitAmbiguity) {
          warnings.push(
            `ambiguous: ${totalMatches} elements matched; tapped index ${index}`,
          );
        }
        if (warnings.length > 0) {
          response.warning = warnings.join('; ');
        }
        if (postInputContext?.warning) {
          response.warning = response.warning
            ? `${response.warning}; ${postInputContext.warning}`
            : postInputContext.warning;
        }

        if (verification?.effect === 'verification_unavailable') {
          response.warning = response.warning
            ? `${response.warning}; The tap was dispatched but post-action AX verification was unavailable.`
            : 'The tap was dispatched but post-action AX verification was unavailable.';
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          };
        }

        if (verification && !verification.verified) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'TAP_NO_EFFECT',
                message:
                  'The tap was dispatched successfully, but no observable AX tree change was detected afterward.',
                ...response,
              }),
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_tap_element] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp a computed tap target to the device coordinate plane.
 *
 * Negative coordinates are clamped to 0 — this preserves taps on
 * elements pinned to the left / top edge whose center calculation
 * under-shoots by a sub-pixel due to AX frame rounding, rather than
 * silently dropping them. Non-finite inputs (NaN, ±Infinity) throw,
 * because no input backend can faithfully forward them.
 *
 * An explicit upper bound is deliberately omitted: resolving a
 * per-device screen size on every tap would require a simctl
 * round-trip, and false-positive clamping against a stale upper bound
 * is more dangerous than letting simctl itself drop out-of-range taps.
 */
export function sanitizeTapTarget(
  x: number,
  y: number,
): { x: number; y: number; clampedFrom?: { x: number; y: number } } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `Invalid tap coordinates (${x}, ${y}): expected finite numbers. The ` +
        `element\u2019s frame is malformed; try refreshing the accessibility tree.`,
    );
  }
  if (x < 0 || y < 0) {
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      clampedFrom: { x, y },
    };
  }
  return { x, y };
}

/**
 * Invoke the Tier 1.5 AX press and turn all recoverable failures into a
 * structured `PressResponse` so the caller can branch cleanly. Bridge-level
 * errors (permission denied, simulator not running, element not found)
 * still propagate — they indicate a setup problem that AX press cannot
 * paper over by falling through to a coordinate tap.
 *
 * Returns `null` when the press path encountered a best-effort failure
 * (e.g., the bridge binary did not resolve). Returns the full response
 * otherwise, including the `PRESS_NOT_ACTIONABLE` case which the caller
 * uses to fall back.
 */
export async function tryPress(
  bridge: AccessibilityBridge,
  elementPath: string,
  deviceId: string,
): Promise<AXPressResponse | null> {
  try {
    return await bridge.press(elementPath, deviceId);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === 'BRIDGE_NOT_FOUND' ||
      code === 'BRIDGE_EXEC_FAILED' ||
      code === 'AX_TIMEOUT'
    ) {
      console.error(
        `[app_tap_element] AX press bridge unavailable (${code}); ` +
          `falling back to coordinate tap. Reason: ${message}`,
      );
      return null;
    }
    throw err;
  }
}

function findNodeByPath(node: AXNode, path: string): AXNode | null {
  let match: AXNode | null = null;
  walkTree(node, (current) => {
    if (!match && current.path === path) {
      match = current;
    }
  });
  return match;
}

export function verifyAXPressEffect(
  beforeTree: AXNode,
  afterTree: AXNode,
  target: AXNode,
): AXPressVerification {
  const beforeTarget = findNodeByPath(beforeTree, target.path);
  const afterTarget = findNodeByPath(afterTree, target.path);

  if (!afterTarget) {
    // Only treat disappearance as a verified effect when the target was
    // actually present before the press. If it was absent from both trees
    // (e.g. deep node truncated by maxDepth: 8), we have no evidence the
    // press did anything — return unverified so the caller falls back to
    // the coordinate path.
    if (!beforeTarget) {
      return { verified: false, effect: 'no_observable_change' };
    }
    return { verified: true, effect: 'target_disappeared' };
  }

  // The target was absent before the press but is now present — treat this
  // as a verified appearance effect (e.g. a lazy-loaded or conditionally
  // rendered element that the tap caused to be inserted into the AX tree).
  if (!beforeTarget && afterTarget) {
    return { verified: true, effect: 'target_appeared' };
  }

  if (!!beforeTarget?.focused !== !!afterTarget.focused) {
    return { verified: true, effect: 'focus_changed' };
  }

  if (fingerprintTree(beforeTree) !== fingerprintTree(afterTree)) {
    return { verified: true, effect: 'subtree_changed' };
  }

  return { verified: false, effect: 'no_observable_change' };
}

const VERIFY_POLL_INTERVAL_MS = 150;
const VERIFY_POLL_TIMEOUT_MS = 1200;

async function verifyCoordinateTapEffect(
  bridge: AccessibilityBridge,
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
      iteration += 1;
      await sleep(VERIFY_POLL_INTERVAL_MS);
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

async function probePostInputContext(args: {
  deviceId: string;
  expectedBundle: string;
}): Promise<{
  probe: Awaited<ReturnType<typeof probeMobileContext>>;
  warning?: string;
}> {
  try {
    const probe = await probeMobileContext({
      deviceId: args.deviceId,
      expectedBundle: args.expectedBundle,
      manager: new SimulatorManager(),
    });
    const warning =
      probe.expectedBundleMatch !== 'matched'
        ? JSON.stringify({
          code: 'POST_TAP_CONTEXT_MISMATCH',
          message:
            `Post-tap context did not confirm expected bundle ${args.expectedBundle}. ` +
            `surface=${probe.surface}, match=${probe.expectedBundleMatch ?? 'unknown'}.`,
          context: probe,
        })
        : undefined;
    return { probe, warning };
  } catch (probeErr) {
    const reason = probeErr instanceof Error ? probeErr.message : String(probeErr);
    console.error(`[app_tap_element] post-tap context probe failed: ${reason}`);
    return {
      probe: {
        deviceId: args.deviceId,
        surface: 'unknown',
        contextVerified: false,
        expectedBundle: args.expectedBundle,
        expectedBundleMatch: 'unknown',
        expectedBundleMatchConfidence: 'unknown',
        reason: 'Post-tap context probe failed.',
        warnings: [reason],
        runningApps: [],
        visibleSummary: {
          buttonLabels: [],
          staticTexts: [],
          textFieldLabels: [],
          nodeCount: 0,
        },
      },
      warning: JSON.stringify({
        code: 'POST_TAP_CONTEXT_PROBE_FAILED',
        message: 'Post-tap context probe failed.',
        reason,
      }),
    };
  }
}

/**
 * Build the MCP response envelope for a successful AX press — shape matches
 * the coordinate-tap response so callers do not need to branch on `backend`
 * to locate `element` / `coordinates` / `_meta`.
 */
export function buildAXPressResponse(args: {
  match: AXNode;
  centerX: number;
  centerY: number;
  deviceId: string;
  totalMatches: number;
  indexProvided: boolean;
  index: number;
  ambiguous: boolean;
  clampedFrom?: { x: number; y: number };
  pressActions: string[];
  effect: AXPressVerification['effect'];
}): Record<string, unknown> {
  const {
    match,
    centerX,
    centerY,
    deviceId,
    totalMatches,
    indexProvided,
    index,
    ambiguous,
    clampedFrom,
    pressActions,
    effect,
  } = args;
  const response: Record<string, unknown> = {
    status: 'tapped',
    element: {
      role: match.role,
      label: match.label,
      identifier: match.identifier,
      path: match.path,
    },
    coordinates: { x: centerX, y: centerY },
    backend: 'ax-press',
    deviceId,
    totalMatches,
    verified: true,
    effect,
    _meta: {
      backendKind: 'ax-press',
      headless: true,
      deviceId,
      axActions: pressActions,
    },
  };
  const implicitAmbiguity = !indexProvided && (ambiguous || totalMatches > 1);
  const warnings: string[] = [];
  if (clampedFrom) {
    response.clampedFrom = clampedFrom;
    // AX press uses the element path rather than `clampedFrom` coordinates,
    // but we still record the clamp for observability — a frame whose
    // center fell outside the device plane is usually a symptom even if
    // this particular tap succeeded.
    warnings.push(
      `tap coordinates clamped to screen bounds from (${clampedFrom.x}, ${clampedFrom.y}); ` +
        `AX press used the element path so the clamp is advisory`,
    );
  }
  if (implicitAmbiguity) {
    warnings.push(
      `ambiguous: ${totalMatches} elements matched; pressed index ${index}`,
    );
    console.error(
      `[app_tap_element] ambiguous query matched ${totalMatches} elements; pressed index ${index}. ` +
        `Pass a narrower query or an explicit index to silence this warning.`,
    );
  }
  if (warnings.length > 0) {
    response.warning = warnings.join('; ');
  }
  return response;
}
