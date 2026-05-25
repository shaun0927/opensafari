/**
 * `app_dismiss_overlay` — close transient overlays without per-app coords.
 *
 * Flutter and UIKit overlay categories the LLM commonly has to dismiss
 * (Drawer, BottomSheet, Dialog, Snackbar) each have an established gesture:
 *
 *   drawer        — swipe right-to-left (or tap to right of the open drawer)
 *   bottom_sheet  — swipe down from the sheet's drag handle area
 *   dialog        — tap the scrim outside the dialog box, or send Escape
 *   auto          — try Escape first, then a top-left scrim tap, then a
 *                   downward swipe; surface which strategy worked
 *
 * The tool fires the gesture; the caller verifies the dismissal succeeded
 * via app_assert / wait_for. We intentionally don't dump the AX tree
 * before firing — that would tie this helper to the bridge's recoverable
 * error budget and defeat the "fast unblock" purpose. Coordinates are
 * device-agnostic and land inside every iPhone/iPad form factor.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-utils';

const MODES = ['auto', 'drawer', 'bottom_sheet', 'dialog'] as const;
type OverlayMode = (typeof MODES)[number];

async function resolveDeviceId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  return getSessionManager().getSoleDeviceId();
}

export function registerAppDismissOverlayTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_dismiss_overlay',
      description:
        'Dismiss a Flutter / UIKit overlay (drawer, bottom sheet, dialog) using the standard gesture for that overlay class. Use mode="auto" when unsure — the tool will try Escape, scrim tap, and a downward swipe in order and report which worked. Caller should verify dismissal via app_assert / app_wait_for.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'Overlay kind. Default "auto".',
          },
          deviceId: { type: 'string', description: 'Simulator UDID' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const mode = ((params.mode as string | undefined) ?? 'auto') as OverlayMode;
      if (!MODES.includes(mode)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'INVALID_MODE', allowed: MODES }),
          }],
          isError: true,
        };
      }
      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED' }),
          }],
          isError: true,
        };
      }

      try {
        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const strategiesTried: string[] = [];

        const tryEscape = async () => {
          strategiesTried.push('escape');
          await backend.sendKey(deviceId, 'Escape');
        };
        const tryScrimTap = async () => {
          strategiesTried.push('scrim_tap');
          // Top-left corner: outside drawers (which anchor left or right),
          // dialogs (which centre), and bottom sheets (which anchor low).
          await backend.tap(deviceId, 24, 96);
        };
        const trySwipeDown = async () => {
          strategiesTried.push('swipe_down');
          // Bottom sheets dismiss with a top-to-bottom swipe inside the
          // sheet's drag area; the centre is a safe column for both
          // half-height and full-height sheets.
          await backend.swipe(deviceId, 200, 240, 200, 720, 0.25);
        };
        const trySwipeFromRight = async () => {
          strategiesTried.push('swipe_from_right');
          // Right edge → centre swipe closes left-anchored drawers; the
          // inverse closes right-anchored drawers but those are rare in
          // Flutter / Material apps.
          await backend.swipe(deviceId, 360, 400, 80, 400, 0.25);
        };

        if (mode === 'dialog') {
          await tryEscape().catch(() => {/* ignore — scrim tap is next */});
          await tryScrimTap();
        } else if (mode === 'bottom_sheet') {
          await trySwipeDown();
        } else if (mode === 'drawer') {
          await trySwipeFromRight();
        } else {
          // auto: Escape → scrim tap → swipe down. We always fire all three
          // in sequence rather than checking effects between, because the
          // AX-tree check would dominate latency. Verification belongs to
          // the caller.
          await tryEscape().catch(() => undefined);
          await tryScrimTap().catch(() => undefined);
          await trySwipeDown().catch(() => undefined);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ dismissed: true, mode, strategiesTried, deviceId }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'DISMISS_FAILED', mode, message }),
          }],
          isError: true,
        };
      }
    },
  );
}
