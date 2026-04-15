/**
 * app_swipe_native — Swipe gesture on the iOS Simulator screen.
 *
 * Calculates start/end coordinates from a direction + distance, then
 * dispatches via `xcrun simctl io <device> input swipe` (or `drag` as
 * fallback for older Xcode versions).
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';

/** Default swipe distance in points. */
const DEFAULT_DISTANCE = 300;
/** Default swipe duration in seconds. */
const DEFAULT_DURATION = 0.5;
/** Default screen center (iPhone 15-class). Callers should pass explicit coords. */
const DEFAULT_CENTER_X = 195;
const DEFAULT_CENTER_Y = 422;

type Direction = 'up' | 'down' | 'left' | 'right';

interface SwipeEndpoint {
  endX: number;
  endY: number;
}

function calculateEndpoint(
  startX: number,
  startY: number,
  direction: Direction,
  distance: number,
): SwipeEndpoint {
  switch (direction) {
    case 'up':
      return { endX: startX, endY: startY - distance };
    case 'down':
      return { endX: startX, endY: startY + distance };
    case 'left':
      return { endX: startX - distance, endY: startY };
    case 'right':
      return { endX: startX + distance, endY: startY };
  }
}

export function registerAppSwipeNativeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_swipe_native',
      description:
        'Swipe gesture on the iOS Simulator screen (works with any app)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Swipe direction',
          },
          startX: {
            type: 'number',
            description: 'Start X coordinate (default: center of screen)',
          },
          startY: {
            type: 'number',
            description: 'Start Y coordinate (default: center of screen)',
          },
          distance: {
            type: 'number',
            description: `Swipe distance in points (default: ${DEFAULT_DISTANCE})`,
          },
          duration: {
            type: 'number',
            description: `Swipe duration in seconds (default: ${DEFAULT_DURATION})`,
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
        const deviceId = resolveDeviceId(params);
        const direction = params.direction as Direction;
        const startX = (params.startX as number | undefined) ?? DEFAULT_CENTER_X;
        const startY = (params.startY as number | undefined) ?? DEFAULT_CENTER_Y;
        const distance = (params.distance as number | undefined) ?? DEFAULT_DISTANCE;
        const duration = (params.duration as number | undefined) ?? DEFAULT_DURATION;

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

        const { endX, endY } = calculateEndpoint(startX, startY, direction, distance);
        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const { meta } = await runInputOp(backend, deviceId, () =>
          backend.swipe(deviceId, startX, startY, endX, endY, duration),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'swiped',
                direction,
                from: { x: startX, y: startY },
                to: { x: endX, y: endY },
                distance,
                duration,
                deviceId,
                backend: backend.kind,
                _meta: meta,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_swipe_native] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

// Exported for testing
export { calculateEndpoint };
