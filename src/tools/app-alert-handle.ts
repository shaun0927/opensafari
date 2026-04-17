import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-backend';
import { runInputOp } from './native-input-utils';
import { getAccessibilityBridge } from '../native/accessibility-bridge';
import type { AXNode } from '../native/ax-types';

/**
 * Walk an AX tree looking for button nodes whose label matches one of the
 * supplied candidate labels (case-insensitive, trimmed). Returns the first
 * matching node in priority order (i.e. the order of `labels`).
 */
function findButtonByLabels(
  node: AXNode,
  labels: string[],
): AXNode | null {
  const normalizedLabels = labels.map((l) => l.trim().toLowerCase());

  // BFS so we find top-level matches first
  const queue: AXNode[] = [node];
  // collect all button candidates first, then match by priority
  const found: Array<{ priorityIndex: number; node: AXNode }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nodeLabel = (current.label ?? '').trim().toLowerCase();
    if (nodeLabel.length > 0) {
      const idx = normalizedLabels.indexOf(nodeLabel);
      if (idx !== -1) {
        found.push({ priorityIndex: idx, node: current });
      }
    }
    if (current.children) {
      for (const child of current.children) {
        queue.push(child);
      }
    }
  }

  if (found.length === 0) return null;

  // Return the highest-priority (lowest index) match
  found.sort((a, b) => a.priorityIndex - b.priorityIndex);
  return found[0].node;
}

/**
 * Collect all visible button labels from the AX tree.
 */
function collectButtonLabels(node: AXNode): string[] {
  const labels: string[] = [];
  const queue: AXNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.label && current.label.trim().length > 0) {
      labels.push(current.label.trim());
    }
    if (current.children) {
      for (const child of current.children) {
        queue.push(child);
      }
    }
  }
  return labels;
}

export function registerAppAlertHandleTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_alert_handle',
      description:
        'Accept or dismiss a system alert/dialog on a booted iOS Simulator. ' +
        'When buttonLabel or buttonLabels is provided, walks the front-most alert\'s ' +
        'accessibility tree and presses the first matching button (case-insensitive, ' +
        'trimmed). Falls back to keyboard input (Return to accept, Escape to dismiss) ' +
        'when no label is supplied. Supports StoreKit, permission sheets, and ' +
        'non-English simulator locales.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['accept', 'dismiss'],
            description:
              'Whether to accept or dismiss the alert. Used for the keyboard ' +
              'fallback path when no buttonLabel(s) are provided.',
          },
          buttonLabel: {
            type: 'string',
            description:
              'Exact (case-insensitive) label of the button to press. ' +
              'Takes precedence over action when provided.',
          },
          buttonLabels: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Ordered list of candidate button labels to try in priority order. ' +
              'The first matching button in the AX tree is pressed. ' +
              'Takes precedence over buttonLabel and action when provided.',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId =
        (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message: 'No booted simulator found. Call device_boot first.',
              }),
            },
          ],
          isError: true,
        };
      }

      // Resolve the candidate label list
      const buttonLabels: string[] | undefined =
        (params.buttonLabels as string[] | undefined) ??
        (params.buttonLabel
          ? [params.buttonLabel as string]
          : undefined);

      // ── AX-press path (label-based) ──────────────────────────────────────
      if (buttonLabels && buttonLabels.length > 0) {
        try {
          const bridge = getAccessibilityBridge();
          const tree = await bridge.dumpTree({ deviceId, maxDepth: 8 });

          const matchedNode = findButtonByLabels(tree, buttonLabels);

          if (!matchedNode) {
            const visibleLabels = collectButtonLabels(tree);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'NO_MATCHING_BUTTON',
                    message:
                      `No button matching ${JSON.stringify(buttonLabels)} found. ` +
                      `Visible button titles: ${JSON.stringify(visibleLabels)}.`,
                    buttonLabels,
                    visibleLabels,
                  }),
                },
              ],
              isError: true,
            };
          }

          const pressResponse = await bridge.press(matchedNode.path, deviceId);

          if (!pressResponse.ok) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'ALERT_HANDLE_FAILED',
                    message:
                      `AX press failed on "${matchedNode.label ?? matchedNode.path}": ` +
                      `${pressResponse.message ?? pressResponse.code}`,
                    code: pressResponse.code,
                    path: matchedNode.path,
                    _meta: {
                      _telemetry: [
                        {
                          backend: 'ax-press',
                          path: matchedNode.path,
                          label: matchedNode.label,
                          axCode: pressResponse.code,
                        },
                      ],
                    },
                  }),
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  handled: true,
                  buttonLabel: matchedNode.label,
                  deviceId,
                  method: 'ax-press',
                  _meta: {
                    _telemetry: [
                      {
                        backend: 'ax-press',
                        path: matchedNode.path,
                        label: matchedNode.label,
                      },
                    ],
                  },
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'ALERT_HANDLE_FAILED',
                  message: `AX label-match failed: ${message}`,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // ── Keyboard fallback path (action-based) ─────────────────────────────
      const action = params.action as string | undefined;

      if (!action) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'MISSING_PARAMS',
                message:
                  'Either action ("accept"|"dismiss") or buttonLabel/buttonLabels must be provided.',
              }),
            },
          ],
          isError: true,
        };
      }

      if (action !== 'accept' && action !== 'dismiss') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'INVALID_ACTION',
                message: `Invalid action "${action}". Must be "accept" or "dismiss".`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Use the input backend to send the appropriate key
      // Return/Enter accepts alerts, Escape dismisses them
      const keyName = action === 'accept' ? 'Return' : 'Escape';

      try {
        const backend = await getInputBackend(deviceId);
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.sendKey(deviceId, keyName),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                handled: true,
                action,
                deviceId,
                method: 'input_backend',
                _meta: meta,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'ALERT_HANDLE_FAILED',
                message: `Failed to ${action} alert: ${message}. No visible alert may be present.`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
