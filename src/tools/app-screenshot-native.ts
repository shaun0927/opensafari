/**
 * app_screenshot_native — Capture native app screenshots (device-level).
 *
 * Uses simctl io to capture the full simulator screen, independent of Safari/WebKit.
 * Useful for native app testing and debugging.
 *
 * Retry behavior: `simctl io … screenshot` emits a transient
 * `Timeout waiting for screen surfaces` right after high-velocity input
 * events (large-distance swipes / rapid scrolls) while the simulator is
 * still compositing. We retry up to SCREENSHOT_MAX_RETRIES times with a
 * short backoff before surfacing the error. Informational lines printed
 * on stderr (e.g. `Note: No display specified.`) are filtered out of the
 * error message so operators see the actual failure signal.
 */

import * as fs from 'fs/promises';
import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId, tempPath } from './native-observability-utils';

const SCREENSHOT_TIMEOUT_MS = 20_000;
const SCREENSHOT_MAX_RETRIES = 2;
const SCREENSHOT_RETRY_DELAY_MS = 1500;
const TRANSIENT_TIMEOUT_PATTERN = /Timeout waiting for screen surfaces/i;
const STDERR_NOISE_PATTERNS: RegExp[] = [
  // The "Note: No display specified." line is emitted by simctl as an
  // informational message. It can appear at the start of stderr or after
  // the `simctl … failed:` prefix injected by SimctlError, so we match
  // the substring rather than anchoring to line starts.
  /Note: No display specified\.[^\n]*/g,
];

function isTransientScreenshotError(message: string): boolean {
  return TRANSIENT_TIMEOUT_PATTERN.test(message);
}

export function stripInformationalStderr(message: string): string {
  let cleaned = message;
  for (const pattern of STDERR_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  // Collapse whitespace runs left behind after noise removal.
  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureWithRetry(
  simctl: SimctlExecutor,
  args: string[],
): Promise<{ attempts: number; retries: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SCREENSHOT_MAX_RETRIES; attempt++) {
    try {
      await simctl.exec(args, { timeout: SCREENSHOT_TIMEOUT_MS });
      return { attempts: attempt + 1, retries: attempt };
    } catch (err) {
      lastError = err;
      const msg = (err as Error).message ?? '';
      if (!isTransientScreenshotError(msg) || attempt === SCREENSHOT_MAX_RETRIES) {
        throw err;
      }
      await sleep(SCREENSHOT_RETRY_DELAY_MS);
    }
  }
  // Unreachable — loop either returns or throws — but keeps TS happy.
  throw lastError as Error;
}

export function registerAppScreenshotNativeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_screenshot_native',
      description:
        'Capture a native app screenshot at the device level (full simulator screen, not browser-only). Supports PNG/JPEG and optional status bar masking. Retries transient simctl "Timeout waiting for screen surfaces" errors up to 2 times with a short backoff.',
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

        const { retries } = await captureWithRetry(simctl, [
          'io',
          deviceId,
          'screenshot',
          `--type=${format}`,
          tmpFile,
        ]);

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
                retries,
              }),
            },
          ],
        };
      } catch (err) {
        const raw = (err as Error).message ?? String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error capturing screenshot: ${stripInformationalStderr(raw)}`,
            },
          ],
          isError: true,
        };
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    },
  );
}

/** @internal — exposed for tests only. */
export const _internal = {
  SCREENSHOT_TIMEOUT_MS,
  SCREENSHOT_MAX_RETRIES,
  SCREENSHOT_RETRY_DELAY_MS,
  isTransientScreenshotError,
  stripInformationalStderr,
};
