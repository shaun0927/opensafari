/**
 * app_scroll_native — Scroll a native view in the iOS Simulator.
 *
 * Calculates start/end coordinates from a direction + amount, then
 * dispatches via `xcrun simctl io <device> input swipe`.
 * Unlike app_swipe_native, this tool is specifically designed for
 * scrolling scrollable views (lists, collection views, etc.) with
 * sensible defaults for scroll amount and center coordinates.
 */

import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-backend';

/** Default scroll amount in points. */
const DEFAULT_AMOUNT = 300;
/** Default screen center X (iPhone 15-class). */
const DEFAULT_CENTER_X = 195;
/** Default screen center Y (iPhone 15-class). */
const DEFAULT_CENTER_Y = 422;

type Direction = 'up' | 'down' | 'left' | 'right';

interface ScrollEndpoint {
  endX: number;
  endY: number;
}

function calculateScrollEndpoint(
  startX: number,
  startY: number,
  direction: Direction,
  amount: number,
): ScrollEndpoint {
  switch (direction) {
    case 'up':
      return { endX: startX, endY: startY - amount };
    case 'down':
      return { endX: startX, endY: startY + amount };
    case 'left':
      return { endX: startX - amount, endY: startY };
    case 'right':
      return { endX: startX + amount, endY: startY };
  }
}

export function registerAppScrollNativeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_scroll_native',
      description:
        'Scroll a native view in the iOS Simulator (works with any app, not just Safari)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction',
          },
          amount: {
            type: 'number',
            description: `Scroll amount in pixels (default: ${DEFAULT_AMOUNT})`,
          },
          x: {
            type: 'number',
            description: `Center X coordinate of the scroll area (default: ${DEFAULT_CENTER_X})`,
          },
          y: {
            type: 'number',
            description: `Center Y coordinate of the scroll area (default: ${DEFAULT_CENTER_Y})`,
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['direction'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const direction = params.direction as Direction;
        const amount = (params.amount as number | undefined) ?? DEFAULT_AMOUNT;
        const x = (params.x as number | undefined) ?? DEFAULT_CENTER_X;
        const y = (params.y as number | undefined) ?? DEFAULT_CENTER_Y;

        const validDirections: Direction[] = ['up', 'down', 'left', 'right'];
        if (!validDirections.includes(direction)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Invalid direction "${direction}". Must be one of: ${validDirections.join(', ')}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const sm = getSessionManager();
        const manager = new SimulatorManager();
        const booted = await manager.listBooted();
        const deviceId =
          (params.deviceId as string | undefined) ??
          sm.getActiveDeviceId() ??
          booted[0]?.udid;

        if (!deviceId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'DEVICE_NOT_FOUND',
                  message:
                    'No device specified and no booted simulator found. Call device_boot first.',
                }),
              },
            ],
            isError: true,
          };
        }

        const { endX, endY } = calculateScrollEndpoint(x, y, direction, amount);
        const backend = await getInputBackend(deviceId);
        await backend.swipe(deviceId, x, y, endX, endY);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'scrolled',
                direction,
                amount,
                from: { x, y },
                to: { x: endX, y: endY },
                deviceId,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_scroll_native] ${message}`);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: message }) },
          ],
          isError: true,
        };
      }
    },
  );
}

// Exported for testing
export { calculateScrollEndpoint };
