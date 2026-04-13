/**
 * qa_flutter_dark_mode — Check dark mode rendering for Flutter/native apps.
 *
 * Takes screenshots in both light and dark mode, compares them, and reports
 * the visual difference. Relies on simctl appearance toggle and screenshot.
 */

import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function registerQaFlutterDarkModeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_dark_mode',
      description:
        'Check dark mode rendering for a Flutter/native app. Takes screenshots in both light and dark mode, ' +
        'reports whether the app responds to appearance changes. Restores the original appearance after check.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          settle_time: {
            type: 'number',
            description: 'Time in ms to wait after appearance change for UI to settle (default: 1500)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }

        const settleTime = (params.settle_time as number | undefined) ?? 1500;
        const simctl = new SimctlExecutor();
        const tmpDir = os.tmpdir();

        // Get current appearance
        let originalAppearance: 'light' | 'dark' = 'light';
        try {
          const currentAppearance = await simctl.exec([
            'ui', deviceId, 'appearance',
          ]);
          if (currentAppearance.trim().toLowerCase().includes('dark')) {
            originalAppearance = 'dark';
          }
        } catch {
          // Default to light if can't determine
        }

        // Set light mode and screenshot
        await simctl.exec(['ui', deviceId, 'appearance', 'light']);
        await sleep(settleTime);
        const lightPath = path.join(tmpDir, `opensafari-qa-light-${deviceId}.png`);
        await simctl.exec(['io', deviceId, 'screenshot', lightPath]);
        const lightSize = getFileSize(lightPath);

        // Set dark mode and screenshot
        await simctl.exec(['ui', deviceId, 'appearance', 'dark']);
        await sleep(settleTime);
        const darkPath = path.join(tmpDir, `opensafari-qa-dark-${deviceId}.png`);
        await simctl.exec(['io', deviceId, 'screenshot', darkPath]);
        const darkSize = getFileSize(darkPath);

        // Restore original appearance
        await simctl.exec(['ui', deviceId, 'appearance', originalAppearance]);

        // Compare file sizes as a rough proxy for visual difference
        // If screenshots are identical in size, the app likely doesn't respond to dark mode
        const sizeDiff = Math.abs(lightSize - darkSize);
        const sizeDiffPercent = lightSize > 0
          ? Math.round((sizeDiff / lightSize) * 100)
          : 0;

        // The app responds to dark mode if there's meaningful visual difference
        const respondsToDarkMode = sizeDiffPercent > 2;

        // Clean up temp files
        try { fs.unlinkSync(lightPath); } catch { /* ignore */ }
        try { fs.unlinkSync(darkPath); } catch { /* ignore */ }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              detector: 'qa_flutter_dark_mode',
              passed: respondsToDarkMode,
              responds_to_dark_mode: respondsToDarkMode,
              light_screenshot_size: lightSize,
              dark_screenshot_size: darkSize,
              size_diff_percent: sizeDiffPercent,
              original_appearance: originalAppearance,
              summary: respondsToDarkMode
                ? `App responds to dark mode. Screenshot size diff: ${sizeDiffPercent}%.`
                : `App may not respond to dark mode. Screenshot size diff: ${sizeDiffPercent}% (below 2% threshold). Verify manually.`,
            }, null, 2),
          }],
          isError: !respondsToDarkMode,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_dark_mode] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
