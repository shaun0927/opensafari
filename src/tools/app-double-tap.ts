/**
 * app_double_tap — Double-tap at screen coordinates in the iOS Simulator.
 *
 * Sends two rapid taps at the same location with a short inter-tap delay.
 */

import { MCPServer } from '../mcp-server';
import { resolveDeviceId, createSimctl } from './native-input-utils';

/** Delay between the two taps (ms). 50 ms matches typical double-tap cadence. */
const INTER_TAP_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAppDoubleTapTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_double_tap',
      description:
        'Double-tap at screen coordinates in the iOS Simulator (works with any app)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
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

        const simctl = createSimctl();

        // First tap
        await simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
        await delay(INTER_TAP_DELAY_MS);
        // Second tap
        await simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'double_tapped',
                x,
                y,
                deviceId,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_double_tap] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
