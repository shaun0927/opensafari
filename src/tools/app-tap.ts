/**
 * app_tap — Tap on native UI elements at specific coordinates.
 *
 * Uses `xcrun simctl io <device> input tap` to send touch events directly
 * to the Simulator, bypassing WebKit entirely. Works with any app, not
 * just Safari.
 */

import { MCPServer } from '../mcp-server';
import { resolveDeviceId, createSimctl } from './native-input-utils';

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

        if (duration > 0) {
          // Long press: use press with duration
          await simctl.exec([
            'io', deviceId, 'input', 'press', String(x), String(y), String(duration),
          ]);
        } else {
          await simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
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
