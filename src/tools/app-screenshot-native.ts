/**
 * app_screenshot_native — Capture native app screenshots (device-level).
 *
 * Uses simctl io to capture the full simulator screen, independent of Safari/WebKit.
 * Useful for native app testing and debugging.
 */

import * as fs from 'fs/promises';
import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId, tempPath } from './native-observability-utils';

export function registerAppScreenshotNativeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_screenshot_native',
      description:
        'Capture a native app screenshot at the device level (full simulator screen, not browser-only). Supports PNG/JPEG and optional status bar masking.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: png)' },
          mask: {
            type: 'string',
            enum: ['black', 'ignored'],
            description: 'Status bar mask mode. "black" overrides status bar to deterministic values before capture.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const format = (params.format as string) || 'png';
      const mask = params.mask as string | undefined;
      const simctl = new SimctlExecutor();
      const tmpFile = tempPath(format);

      try {
        // If mask is 'black', override status bar to deterministic values
        if (mask === 'black') {
          try {
            await simctl.exec([
              'status_bar',
              deviceId,
              'override',
              '--time',
              '9:41',
              '--batteryLevel',
              '100',
              '--cellularBars',
              '4',
            ]);
          } catch {
            // Status bar override is best-effort; continue with screenshot
          }
        }

        await simctl.exec(['io', deviceId, 'screenshot', `--type=${format}`, tmpFile], {
          timeout: 15000,
        });

        const buffer = await fs.readFile(tmpFile);
        const base64Data = buffer.toString('base64');

        // Clear status bar override if we set one
        if (mask === 'black') {
          try {
            await simctl.exec(['status_bar', deviceId, 'clear']);
          } catch {
            // Best-effort cleanup
          }
        }

        return {
          content: [
            { type: 'image' as const, data: base64Data, mimeType: `image/${format}` },
            {
              type: 'text' as const,
              text: JSON.stringify({
                deviceId,
                format,
                mask: mask ?? 'none',
                capturedAt: new Date().toISOString(),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error capturing screenshot: ${(err as Error).message}` }],
          isError: true,
        };
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    },
  );
}
