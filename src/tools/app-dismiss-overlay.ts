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
 * By default the tool remains a fast gesture helper. Callers that need
 * semantic proof can pass `waitForGone` or `waitForVisible`; the tool will
 * poll the AX tree after dispatch and report a verified postcondition.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { getInputBackend } from './native-input-utils';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { waitForSettle } from './settle-policy';
import {
  wrapHandlerForBundle,
  COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
} from './debug-bundle-attach';

const MODES = ['auto', 'drawer', 'bottom_sheet', 'dialog'] as const;
type OverlayMode = (typeof MODES)[number];

type VerificationKind = 'gone' | 'visible';

interface OverlayVerificationSpec {
  identifier?: string;
  label?: string;
  text?: string;
  role?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

interface OverlayVerificationResult {
  requested: boolean;
  kind?: VerificationKind;
  verified?: boolean;
  query?: Record<string, unknown>;
  elapsedMs?: number;
  polls?: number;
  finalMatchCount?: number;
  strict?: boolean;
  error?: string;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_VERIFY_INTERVAL_MS = 250;

async function resolveDeviceId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  return getSessionManager().getSoleDeviceId();
}

function parseVerification(params: Record<string, unknown>):
  | { kind: VerificationKind; spec: OverlayVerificationSpec; strict: boolean }
  | null {
  const gone = params.waitForGone as OverlayVerificationSpec | undefined;
  const visible = params.waitForVisible as OverlayVerificationSpec | undefined;
  if (gone && visible) {
    throw new Error('Specify only one of waitForGone or waitForVisible');
  }
  const spec = gone ?? visible;
  if (!spec) return null;
  if (!spec.identifier && !spec.label && !spec.text && !spec.role) {
    throw new Error('Verification requires at least one of identifier, label, text, or role');
  }
  return {
    kind: gone ? 'gone' : 'visible',
    spec,
    strict: params.verifyStrict !== false,
  };
}

async function verifyPostcondition(
  deviceId: string,
  kind: VerificationKind,
  spec: OverlayVerificationSpec,
): Promise<OverlayVerificationResult> {
  const query = {
    identifier: spec.identifier,
    label: spec.label,
    text: spec.text,
    role: spec.role,
  };
  const settle = await waitForSettle(deviceId, {
    query,
    condition: kind === 'gone' ? 'not_exists' : 'exists',
    timeoutMs: spec.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    intervalMs: spec.intervalMs ?? DEFAULT_VERIFY_INTERVAL_MS,
    stableMs: 0,
    allowTransientErrors: true,
    maxRecoverableRetries: 2,
  });
  return {
    requested: true,
    kind,
    verified: settle.met,
    query,
    elapsedMs: settle.elapsedMs,
    polls: settle.polls,
    finalMatchCount: settle.matchingCount,
    error: settle.errors.at(-1),
  };
}

export function registerAppDismissOverlayTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_dismiss_overlay',
      description:
        'Dismiss a Flutter / UIKit overlay (drawer, bottom sheet, dialog) using the standard gesture for that overlay class. Use mode="auto" when unsure — the tool will try Escape, scrim tap, and a downward swipe in order. Pass waitForGone or waitForVisible to verify a postcondition.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'Overlay kind. Default "auto".',
          },
          deviceId: { type: 'string', description: 'Simulator UDID' },
          waitForGone: {
            type: 'object',
            description: 'Optional AX postcondition. Verification succeeds once no node matches this query.',
            properties: {
              identifier: { type: 'string' },
              label: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              timeoutMs: { type: 'number' },
              intervalMs: { type: 'number' },
            },
          },
          waitForVisible: {
            type: 'object',
            description: 'Optional AX postcondition. Verification succeeds once at least one node matches this query.',
            properties: {
              identifier: { type: 'string' },
              label: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              timeoutMs: { type: 'number' },
              intervalMs: { type: 'number' },
            },
          },
          verifyStrict: {
            type: 'boolean',
            description: 'When false, a failed optional postcondition is reported as verified=false without setting isError. Default true when a postcondition is supplied.',
          },
          collectDebugBundleOnFailure: COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA,
        },
        required: [],
      },
    },
    wrapHandlerForBundle('app_dismiss_overlay', async (_sessionId: string, params: Record<string, unknown>) => {
      const mode = ((params.mode as string | undefined) ?? 'auto') as OverlayMode;
      if (!MODES.includes(mode)) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'Invalid mode', { allowed: MODES });
      }
      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found');
      }

      let verificationRequest: ReturnType<typeof parseVerification>;
      try {
        verificationRequest = parseVerification(params);
      } catch (err) {
        return respondWithStructuredError(
          ErrorCode.INVALID_INPUT,
          err instanceof Error ? err.message : String(err),
        );
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
          // auto: Escape → scrim tap → swipe down. Without a caller-provided
          // postcondition this stays a fast unblock helper; with one, the AX
          // verification below turns dispatch success into semantic evidence.
          await tryEscape().catch(() => undefined);
          await tryScrimTap().catch(() => undefined);
          await trySwipeDown().catch(() => undefined);
        }

        let verification: OverlayVerificationResult = { requested: false };
        if (verificationRequest) {
          try {
            verification = await verifyPostcondition(
              deviceId,
              verificationRequest.kind,
              verificationRequest.spec,
            );
          } catch (err) {
            verification = {
              requested: true,
              kind: verificationRequest.kind,
              verified: false,
              strict: verificationRequest.strict,
              error: err instanceof Error ? err.message : String(err),
            };
          }
          verification.strict = verificationRequest.strict;
        }

        const verified = verification.requested ? verification.verified === true : null;
        const body = {
          dismissed: !verification.requested || verification.verified === true,
          mode,
          strategiesTried,
          deviceId,
          verified,
          verification,
        };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(body),
          }],
          isError: verification.requested && verification.verified !== true && verification.strict ? true : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respondWithStructuredError(ErrorCode.OVERLAY_DISMISS_FAILED, message, { mode });
      }
    }),
  );
}
