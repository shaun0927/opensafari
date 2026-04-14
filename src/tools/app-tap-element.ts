/**
 * app_tap_element — Tap a native UI element by accessibility query.
 *
 * Combines app_query (find element) + frame center calculation + app_tap
 * (send touch) into a single semantic action. Works with any app including
 * Flutter — no WebKit/DOM required.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import type { AXNode } from '../native';
import { resolveDeviceId, getInputBackend } from './native-input-utils';

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

        // Ensure Flutter semantics are active
        await ensureSemanticsActive(deviceId);

        const bridge = getAccessibilityBridge();
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
        const centerX = match.frame.x + match.frame.width / 2;
        const centerY = match.frame.y + match.frame.height / 2;

        // Tap via input backend
        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        await backend.tap(deviceId, centerX, centerY, duration > 0 ? duration : undefined);

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
        };
        if (implicitAmbiguity) {
          response.warning = `ambiguous: ${totalMatches} elements matched; tapped index ${index}`;
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
