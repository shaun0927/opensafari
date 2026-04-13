/**
 * flutter_toggle_debug_paint — Toggle Flutter's built-in debug paint flags
 * (layout bounds, baselines, repaint rainbow) and time dilation.
 *
 * Motivation (issue #437): overflow, bad padding, and unintended Expanded
 * behaviour are hard to diagnose from screenshots alone. The Flutter
 * framework exposes debug overlays that are trivial to toggle through the
 * VM Service but have not been exposed as an MCP tool yet.
 *
 * Modes:
 *   - "size"             → ext.flutter.debugPaint                  (layout bounds)
 *   - "baseline"         → ext.flutter.debugPaintBaselinesEnabled  (text baselines)
 *   - "repaint_rainbow"  → ext.flutter.repaintRainbow              (repaint regions)
 *   - "time_dilation"    → ext.flutter.timeDilation                (slow-motion)
 *   - "all_off"          → resets all of the above                 (sanity / restore)
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';

export type DebugPaintMode =
  | 'size'
  | 'baseline'
  | 'repaint_rainbow'
  | 'time_dilation'
  | 'all_off';

const MODE_TO_EXTENSION: Record<Exclude<DebugPaintMode, 'time_dilation' | 'all_off'>, string> = {
  size: 'debugPaint',
  baseline: 'debugPaintBaselinesEnabled',
  repaint_rainbow: 'repaintRainbow',
};

export function registerFlutterDebugPaintTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_toggle_debug_paint',
      description:
        'Toggle Flutter debug overlays (layout bounds, baselines, repaint rainbow) ' +
        'or time dilation on a connected Flutter app. Use size/baseline/repaint_rainbow ' +
        'with enable=true/false to flip flags; use time_dilation with dilation_factor ' +
        'to slow animations (1.0 = normal, 2.0 = half speed); use all_off to reset ' +
        'every flag. Requires an active flutter_connect session (debug/profile builds).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: ['size', 'baseline', 'repaint_rainbow', 'time_dilation', 'all_off'],
            description: 'Which debug overlay to toggle.',
          },
          enable: {
            type: 'boolean',
            description: 'For size / baseline / repaint_rainbow: turn the overlay on or off.',
          },
          dilation_factor: {
            type: 'number',
            description: 'For time_dilation: multiplier (1.0 = normal speed, 2.0 = half speed).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['mode'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const mode = params.mode as DebugPaintMode | undefined;
        if (!mode) {
          throw new Error('mode is required (size | baseline | repaint_rainbow | time_dilation | all_off)');
        }

        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device. Boot a simulator first.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        const results: Array<{ extension: string; params: Record<string, unknown> }> = [];

        if (mode === 'all_off') {
          // Reset every flag we know about.
          await client.callServiceExtension('debugPaint', { enabled: 'false' });
          results.push({ extension: 'ext.flutter.debugPaint', params: { enabled: 'false' } });

          await client.callServiceExtension('debugPaintBaselinesEnabled', { enabled: 'false' });
          results.push({ extension: 'ext.flutter.debugPaintBaselinesEnabled', params: { enabled: 'false' } });

          await client.callServiceExtension('repaintRainbow', { enabled: 'false' });
          results.push({ extension: 'ext.flutter.repaintRainbow', params: { enabled: 'false' } });

          await client.callServiceExtension('timeDilation', { timeDilation: '1.0' });
          results.push({ extension: 'ext.flutter.timeDilation', params: { timeDilation: '1.0' } });
        } else if (mode === 'time_dilation') {
          const factor = params.dilation_factor;
          if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
            throw new Error('dilation_factor must be a positive number (1.0 = normal)');
          }
          await client.callServiceExtension('timeDilation', { timeDilation: String(factor) });
          results.push({ extension: 'ext.flutter.timeDilation', params: { timeDilation: String(factor) } });
        } else {
          const enable = params.enable;
          if (typeof enable !== 'boolean') {
            throw new Error(`mode "${mode}" requires enable (boolean)`);
          }
          const extensionName = MODE_TO_EXTENSION[mode];
          const payload = { enabled: enable ? 'true' : 'false' };
          await client.callServiceExtension(extensionName, payload);
          results.push({ extension: `ext.flutter.${extensionName}`, params: payload });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              mode,
              applied: results,
              deviceId,
              hint: 'Call app_screenshot_native to capture the updated overlay, then all_off to restore.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_toggle_debug_paint] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
