/**
 * app_type_element — Type text into a native UI element located by
 * accessibility query.
 *
 * Chains `app_query` (find element) → tap-to-focus → `app_type_text`
 * into a single semantic action. This is the paired companion to
 * `app_tap_element`: where tap_element targets buttons, this one
 * targets text fields (or anything else that accepts keyboard input
 * once focused).
 *
 * Works with any app including Flutter — no WebKit/DOM required.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import type { AXNode, AXQuery } from '../native';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';
import { tryPress } from './app-tap-element';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FOCUS_DELAY_MS = 150;

export function registerAppTypeElementTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_type_element',
      description:
        'Type text into a native app UI element located by accessibility query ' +
        '(label, identifier, or role). Finds the element in the accessibility ' +
        'tree, taps its center to focus it, then types the given text via the ' +
        'same input backend used by app_type_text. Works with any app ' +
        'including Flutter — no WebKit/DOM required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Text to type into the focused element',
          },
          identifier: {
            type: 'string',
            description: 'Accessibility identifier (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label (case-insensitive substring)',
          },
          role: {
            type: 'string',
            description: 'Accessibility role (e.g. "AXTextField")',
          },
          index: {
            type: 'number',
            description: 'Which match to focus when multiple found (0-based, default: 0)',
          },
          timeout: {
            type: 'number',
            description: `Max ms to wait for the element to appear (default: ${DEFAULT_TIMEOUT_MS}). Set to 0 to skip waiting.`,
          },
          focusDelay: {
            type: 'number',
            description: `Ms to wait between tap-to-focus and typing (default: ${DEFAULT_FOCUS_DELAY_MS}). Increase for slow keyboards.`,
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['text'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const textToType = params.text as string | undefined;
      const identifier = params.identifier as string | undefined;
      const label = params.label as string | undefined;
      const role = params.role as string | undefined;

      if (typeof textToType !== 'string' || textToType.length === 0) {
        return jsonError('text must be a non-empty string');
      }
      if (!identifier && !label && !role) {
        return jsonError(
          'At least one query parameter (identifier, label, or role) is required to locate the field',
        );
      }

      try {
        const deviceId = resolveDeviceId(params);
        const index = (params.index as number | undefined) ?? 0;
        const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;
        const focusDelay = (params.focusDelay as number | undefined) ?? DEFAULT_FOCUS_DELAY_MS;

        await ensureSemanticsActive(deviceId);

        const bridge = getAccessibilityBridge();
        // Note: the bridge supports a `text` query param (searches label/value),
        // but `text` here is overloaded to mean "text to type". So we never pass
        // `text` as a query — callers disambiguate via identifier/label/role.
        const query: AXQuery = { identifier, label, role };

        let match: AXNode | undefined;
        if (timeout > 0) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const result = await bridge.query(query, { deviceId });
            if (result.matches.length > index) {
              match = result.matches[index];
              break;
            }
            await sleep(300);
          }
        } else {
          const result = await bridge.query(query, { deviceId });
          if (result.matches.length > index) {
            match = result.matches[index];
          }
        }
        if (!match) {
          return jsonError('Element not found', { query, index, timeout });
        }

        if (!match.visible || match.frame.width <= 0 || match.frame.height <= 0) {
          return jsonError('Element found but not visible or has zero size', {
            element: {
              role: match.role,
              label: match.label,
              identifier: match.identifier,
              frame: match.frame,
              visible: match.visible,
            },
          });
        }

        // Focus step: prefer Tier 1.5 AX press (headless — no mouse
        // movement, no Simulator.app foregrounding). Fall back to a
        // coordinate tap via the selected input backend when AX press is
        // not actionable or is explicitly disabled via env var.
        const centerX = match.frame.x + match.frame.width / 2;
        const centerY = match.frame.y + match.frame.height / 2;

        const axPressDisabled =
          process.env.OPENSAFARI_DISABLE_AX_PRESS === '1' ||
          process.env.OPENSAFARI_DISABLE_AX_PRESS === 'true';
        const pressResponse =
          !axPressDisabled && match.path
            ? await tryPress(bridge, match.path, deviceId)
            : null;
        const focusedViaAXPress = pressResponse?.ok === true;
        if (pressResponse && pressResponse.code === 'PRESS_NOT_ACTIONABLE') {
          console.error(
            `[app_type_element] AX press not actionable for path ${match.path} ` +
              `(role=${match.role}, id=${match.identifier ?? '-'}); ` +
              `falling back to coordinate tap for focus.`,
          );
        } else if (pressResponse && pressResponse.code === 'PRESS_FAILED') {
          console.error(
            `[app_type_element] AXPress action fired but returned non-success ` +
              `(axErrorCode=${pressResponse.axErrorCode}, path=${match.path}); ` +
              `falling back to coordinate tap for focus.`,
          );
        }

        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const { meta } = await runInputOp(backend, deviceId, async () => {
          if (!focusedViaAXPress) {
            await backend.tap(deviceId, centerX, centerY);
          }
          if (focusDelay > 0) {
            await sleep(focusDelay);
          }
          await backend.typeText(deviceId, textToType);
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'typed',
                element: {
                  role: match.role,
                  label: match.label,
                  identifier: match.identifier,
                  path: match.path,
                },
                coordinates: { x: centerX, y: centerY },
                length: textToType.length,
                backend: backend.kind,
                focusBackend: focusedViaAXPress ? 'ax-press' : backend.kind,
                deviceId,
                _meta: meta,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_type_element] ${message}`);
        return jsonError(message);
      }
    },
  );
}

function jsonError(error: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error, ...extra }) }],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
