/**
 * app_type_element — Type text into a native UI element located by
 * accessibility query.
 *
 * Chains `app_query` (find element) → tap-to-focus → `app_type_text`
 * into a single semantic action. This is the paired companion to
 * `app_tap_element`: where tap_element targets buttons, this one
 * targets text fields (or anything else that accepts keyboard input
 * once focused).
 *
 * Works with any app including Flutter — no WebKit/DOM required.
 *
 * ## Keyboard-layout limitation (issue #639 Problem 1)
 *
 * When `backend: "auto"` (default), text is sent via raw HID keycodes
 * that assume a US-ABC (QWERTY) software keyboard. If the simulator's
 * active input source is non-Latin (Korean 2-Set, Japanese Kana, Chinese
 * Pinyin, …) those keycodes are silently re-composed by the iOS IME into
 * the corresponding script — producing garbage in the text field.
 *
 * There is currently no documented way to switch the simulator's input
 * source programmatically from the host. Until a native switcher lands,
 * use `backend: "pasteboard"` which round-trips via the simulator
 * clipboard (Cmd+V) and is fully keyboard-layout-independent.
 *
 * When post-typing readback (`verifyAfterTyping: true`, or the legacy
 * `verify: true` default) detects divergence AND the detected keyboard
 * layout is non-Latin, the tool returns `isError: true` with:
 *
 *   { code: "TEXT_INPUT_LAYOUT_MISMATCH", expected, actual,
 *     suggestedBackend: "pasteboard", detectedLayout }
 *
 * For Latin layouts where characters are dropped (different failure
 * mode), see error code `TEXT_INPUT_DROPPED` (PR A / issue #639).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { MCPServer, getWebKitClient } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import type { AXNode, AXQuery } from '../native';
import { resolveDeviceId, getInputBackend, runInputOp } from './native-input-utils';
import { tryPress } from './app-tap-element';
import { typeViaPasteboard, type PasteNotAppliedError } from './pasteboard-input';
import { mismatchHint } from './keyboard-layout';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FOCUS_DELAY_MS = 150;
const SUPPORTED_BACKENDS = ['auto', 'pasteboard'] as const;
type TypeBackendChoice = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Maximum number of characters of the observed AX value to echo back in
 * `verify_reason`. The raw value can contain PII (email, password), so we
 * cap the echo to the first few chars — enough to prove mismatch without
 * leaking the rest of the field. The expected-text side is truncated
 * symmetrically.
 */
const VERIFY_ECHO_LEN = 24;

/**
 * Post-typing verification result. Attached to the tool response so callers
 * can distinguish a real typed value from a silent IME transliteration
 * (issue #39 Tier 3).
 */
interface VerifyResult {
  verified: boolean | 'unknown';
  verify_method:
    | 'ax-value-readback'
    | 'ax-value-not-readable'
    | 'skipped-non-simhid'
    | 'readback-failed';
  verify_reason?: string;
  /**
   * Raw AX-value observed at readback. Populated only when the readback
   * actually succeeded (`verify_method === 'ax-value-readback'`); used by the
   * caller to attach structured error payloads (e.g. TEXT_INPUT_LAYOUT_MISMATCH
   * — issue #639 Problem 1) without re-querying the AX bridge.
   */
  observed?: string;
}

export function registerAppTypeElementTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_type_element',
      description:
        'Type text into a native app UI element located by accessibility query ' +
        '(label, identifier, or role). Finds the element in the accessibility ' +
        'tree, taps its center to focus it, then types the given text via the ' +
        'same input backend used by app_type_text. Works with any app ' +
        'including Flutter — no WebKit/DOM required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Text to type into the focused element',
          },
          identifier: {
            type: 'string',
            description: 'Accessibility identifier (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label (case-insensitive substring)',
          },
          role: {
            type: 'string',
            description: 'Accessibility role (e.g. "AXTextField")',
          },
          index: {
            type: 'number',
            description: 'Which match to focus when multiple found (0-based, default: 0)',
          },
          timeout: {
            type: 'number',
            description: `Max ms to wait for the element to appear (default: ${DEFAULT_TIMEOUT_MS}). Set to 0 to skip waiting.`,
          },
          focusDelay: {
            type: 'number',
            description: `Ms to wait between tap-to-focus and typing (default: ${DEFAULT_FOCUS_DELAY_MS}). Increase for slow keyboards.`,
          },
          backend: {
            type: 'string',
            enum: [...SUPPORTED_BACKENDS],
            description:
              'Typing backend. "auto" (default) uses the HID/simhid path — fast, but bound to the simulator\'s active software keyboard layout and silently transliterates through non-Latin keyboards (see #39). "pasteboard" round-trips via the simulator pasteboard + Cmd+V, bypassing the software keyboard entirely — Unicode-safe (CJK, emoji), keyboard-layout-independent.',
          },
          restorePasteboard: {
            type: 'boolean',
            description:
              'When backend="pasteboard": restore the original simulator pasteboard after typing (default: true).',
          },
          autoAcceptPastePermission: {
            type: 'boolean',
            description:
              'When backend="pasteboard": auto-accept the iOS 16+ paste-permission dialog if it appears (default: true).',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          verify: {
            type: 'boolean',
            description:
              'Opt out of post-typing readback verification (default: true). When false the tool reports `verified: "unknown"` without reading back the AX value.',
          },
          perKeyDelayMs: {
            type: 'number',
            description:
              'When backend resolves to simhid (HID keyboard): inserts an inter-character pause between consecutive key sends. Default 0 (no pause). Required for segmented OTP-style fields (e.g. 6-cell verify-code inputs in Flutter) that drop characters when keys arrive faster than the field can advance focus. Recommended: 80–150 ms for 6-digit OTP inputs.',
          },
        },
        required: ['text'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const textToType = params.text as string | undefined;
      const identifier = params.identifier as string | undefined;
      const label = params.label as string | undefined;
      const role = params.role as string | undefined;
      const backendChoice = ((params.backend as string | undefined) ?? 'auto') as TypeBackendChoice;
      if (!SUPPORTED_BACKENDS.includes(backendChoice)) {
        return jsonError(
          `backend must be one of: ${SUPPORTED_BACKENDS.join(', ')} (got "${backendChoice}")`,
        );
      }

      if (typeof textToType !== 'string' || textToType.length === 0) {
        return jsonError('text must be a non-empty string');
      }
      if (!identifier && !label && !role) {
        return jsonError(
          'At least one query parameter (identifier, label, or role) is required to locate the field',
        );
      }

      try {
        const deviceId = resolveDeviceId(params);
        const index = (params.index as number | undefined) ?? 0;
        const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;
        const focusDelay = (params.focusDelay as number | undefined) ?? DEFAULT_FOCUS_DELAY_MS;
        const verifyOptIn =
          typeof params.verify === 'boolean' ? (params.verify as boolean) : true;
        const perKeyDelayMsRaw = params.perKeyDelayMs;
        const perKeyDelayMs =
          typeof perKeyDelayMsRaw === 'number' &&
          Number.isFinite(perKeyDelayMsRaw) &&
          perKeyDelayMsRaw > 0
            ? perKeyDelayMsRaw
            : 0;

        await ensureSemanticsActive(deviceId);

        const bridge = getAccessibilityBridge();
        // Note: the bridge supports a `text` query param (searches label/value),
        // but `text` here is overloaded to mean "text to type". So we never pass
        // `text` as a query — callers disambiguate via identifier/label/role.
        const query: AXQuery = { identifier, label, role };

        let match: AXNode | undefined;
        if (timeout > 0) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const result = await bridge.query(query, { deviceId });
            if (result.matches.length > index) {
              match = result.matches[index];
              break;
            }
            await sleep(300);
          }
        } else {
          const result = await bridge.query(query, { deviceId });
          if (result.matches.length > index) {
            match = result.matches[index];
          }
        }
        if (!match) {
          return jsonError('Element not found', { query, index, timeout });
        }

        if (!match.visible || match.frame.width <= 0 || match.frame.height <= 0) {
          return jsonError('Element found but not visible or has zero size', {
            element: {
              role: match.role,
              label: match.label,
              identifier: match.identifier,
              frame: match.frame,
              visible: match.visible,
            },
          });
        }

        // Focus step: prefer Tier 1.5 AX press (headless — no mouse
        // movement, no Simulator.app foregrounding). Fall back to a
        // coordinate tap via the selected input backend when AX press is
        // not actionable or is explicitly disabled via env var.
        const centerX = match.frame.x + match.frame.width / 2;
        const centerY = match.frame.y + match.frame.height / 2;

        const axPressDisabled =
          process.env.OPENSAFARI_DISABLE_AX_PRESS === '1' ||
          process.env.OPENSAFARI_DISABLE_AX_PRESS === 'true';
        const pressResponse =
          !axPressDisabled && match.path
            ? await tryPress(bridge, match.path, deviceId)
            : null;
        const focusedViaAXPress = pressResponse?.ok === true;
        if (pressResponse && pressResponse.code === 'PRESS_NOT_ACTIONABLE') {
          console.error(
            `[app_type_element] AX press not actionable for path ${match.path} ` +
              `(role=${match.role}, id=${match.identifier ?? '-'}); ` +
              `falling back to coordinate tap for focus.`,
          );
        } else if (pressResponse && pressResponse.code === 'PRESS_FAILED') {
          console.error(
            `[app_type_element] AXPress action fired but returned non-success ` +
              `(axErrorCode=${pressResponse.axErrorCode}, path=${match.path}); ` +
              `falling back to coordinate tap for focus.`,
          );
        }

        const backend = await getInputBackend(deviceId, getWebKitClient(deviceId));
        const elementDescriptor = {
          role: match.role,
          label: match.label,
          identifier: match.identifier,
          path: match.path,
        };

        if (backendChoice === 'pasteboard') {
          // Focus first (via AX press when possible, else coordinate tap).
          if (!focusedViaAXPress) {
            await backend.tap(deviceId, centerX, centerY);
          }
          if (focusDelay > 0) {
            await sleep(focusDelay);
          }

          const restorePasteboard = (params.restorePasteboard as boolean | undefined) ?? true;
          const autoAcceptPastePermission =
            (params.autoAcceptPastePermission as boolean | undefined) ?? true;

          let pasteResult;
          try {
            pasteResult = await typeViaPasteboard(deviceId, textToType, {
              restorePasteboard,
              autoAcceptPastePermission,
              expected: textToType,
              focusedElementPath: match.path,
            });
          } catch (err) {
            if (err instanceof Error && (err as unknown as PasteNotAppliedError).code === 'PASTE_NOT_APPLIED') {
              const e = err as unknown as PasteNotAppliedError;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      error: 'PASTE_NOT_APPLIED',
                      code: e.code,
                      expected: e.expected,
                      actual: e.actual,
                      permissionDialogObserved: e.permissionDialogObserved,
                      element: elementDescriptor,
                      deviceId,
                    }),
                  },
                ],
                isError: true,
              };
            }
            throw err;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'typed',
                  element: elementDescriptor,
                  coordinates: { x: centerX, y: centerY },
                  length: textToType.length,
                  backend: 'pasteboard',
                  focusBackend: focusedViaAXPress ? 'ax-press' : backend.kind,
                  pasteboardRestored: pasteResult.pasteboardRestored,
                  permissionDialog: pasteResult.permissionDialog,
                  permissionDialogMatchedLabel:
                    pasteResult.permissionDialogMatchedLabel,
                  elapsedMs: pasteResult.elapsedMs,
                  deviceId,
                }),
              },
            ],
          };
        }

        const { meta } = await runInputOp(backend, deviceId, async () => {
          if (!focusedViaAXPress) {
            await backend.tap(deviceId, centerX, centerY);
          }
          if (focusDelay > 0) {
            await sleep(focusDelay);
          }
          await backend.typeText(deviceId, textToType, perKeyDelayMs);
        });

        // Tier-3 readback verification (issue #39). We only run the readback
        // when the dispatch tier was `simhid`, because that is the backend
        // that silently transliterates on non-Latin keyboards. Tiers that
        // bypass the software keyboard entirely (flutter-vm, webkit) don't
        // have the transliteration failure mode. Opt out via `verify: false`.
        const verify = verifyOptIn
          ? await verifyTypedText(backend.kind, bridge, match.path, textToType, deviceId)
          : {
              verified: 'unknown' as const,
              verify_method: 'skipped-non-simhid' as const,
              verify_reason: 'verify: false passed by caller',
            };

        // Best-effort keyboard-layout detection for the diagnostic field.
        // Never blocks typing; a failed probe produces `null` and the field
        // is simply omitted.
        const keyboardLayoutDetected = await detectKeyboardLayout(deviceId);

        const responseBody: Record<string, unknown> = {
          status: 'typed',
          element: elementDescriptor,
          coordinates: { x: centerX, y: centerY },
          length: textToType.length,
          backend: backend.kind,
          focusBackend: focusedViaAXPress ? 'ax-press' : backend.kind,
          deviceId,
          verified: verify.verified,
          verify_method: verify.verify_method,
          _meta: meta,
        };
        if (verify.verify_reason) {
          responseBody.verify_reason = verify.verify_reason;
        }
        if (keyboardLayoutDetected) {
          responseBody.keyboard_layout_detected = keyboardLayoutDetected;
        }

        // Silent-failure fix: when verification detected a real mismatch,
        // surface `isError: true` so MCP clients / agents don't treat the
        // call as a trustworthy "typed" step and proceed to submit garbage.
        const mismatched = verify.verified === false;

        // When verification observed a mismatch AND the simulator's keyboard
        // layout is non-Latin, attach a structured TEXT_INPUT_LAYOUT_MISMATCH
        // payload so callers can programmatically pick the recommended
        // remediation (issue #639 Problem 1). Latin-layout mismatches use a
        // different code (TEXT_INPUT_DROPPED — see PR A) and are intentionally
        // skipped here.
        if (mismatched && verify.observed !== undefined) {
          const hint = mismatchHint(textToType, verify.observed, keyboardLayoutDetected);
          if (hint) {
            responseBody.error = hint;
          }
        }
        const result: {
          content: Array<{ type: 'text'; text: string }>;
          isError?: boolean;
        } = {
          content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
        };
        if (mismatched) {
          result.isError = true;
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_type_element] ${message}`);
        return jsonError(message);
      }
    },
  );
}

/**
 * Post-typing verification. Re-reads the focused element's AX value and
 * compares it to what the caller asked to type. Silent transliteration on
 * non-Latin simulator keyboards (issue #39) is the primary failure mode
 * this catches — the raw HID keycodes sent by simhid produce Jamo/Kana/…
 * in the Dart/native controller, and the readback will diverge immediately.
 *
 * Semantics:
 *   - `verified: true` — observed AX value contains the expected text as a
 *     suffix. (Suffix match, not equality, because callers may type into a
 *     field that already contained text; the typed input is appended.)
 *   - `verified: false` — observed value is readable but does not contain
 *     the expected text. The `verify_reason` carries truncated expected /
 *     observed fragments for triage.
 *   - `verified: 'unknown'` — the element has no AXValue (e.g. a password
 *     field whose value is suppressed), readback throws, or the backend
 *     was not simhid so the check was skipped. Callers should treat this
 *     as "could not prove the typing succeeded" rather than "it succeeded".
 */
async function verifyTypedText(
  backendKind: string,
  bridge: ReturnType<typeof getAccessibilityBridge>,
  elementPath: string,
  expected: string,
  deviceId: string,
): Promise<VerifyResult> {
  if (backendKind !== 'simhid') {
    return {
      verified: 'unknown',
      verify_method: 'skipped-non-simhid',
      verify_reason: `backend=${backendKind} bypasses software keyboard; readback verification only applies to simhid`,
    };
  }
  if (!elementPath) {
    return {
      verified: 'unknown',
      verify_method: 'ax-value-not-readable',
      verify_reason: 'element has no AX path to re-inspect',
    };
  }
  let observed: string | undefined;
  try {
    const node = await bridge.inspect(elementPath, deviceId);
    observed = node.value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verified: 'unknown',
      verify_method: 'readback-failed',
      verify_reason: `AX inspect failed: ${msg}`,
    };
  }
  if (observed === undefined || observed === null) {
    return {
      verified: 'unknown',
      verify_method: 'ax-value-not-readable',
      verify_reason: 'element exposes no AXValue (e.g. password field)',
    };
  }
  if (observed.endsWith(expected) || observed.includes(expected)) {
    return { verified: true, verify_method: 'ax-value-readback', observed };
  }
  return {
    verified: false,
    verify_method: 'ax-value-readback',
    verify_reason:
      `observed "${truncate(observed)}" does not contain requested "${truncate(expected)}" — ` +
      'likely caused by a non-Latin simulator keyboard transliterating the HID input (issue #39)',
    observed,
  };
}

function truncate(s: string): string {
  if (s.length <= VERIFY_ECHO_LEN) return s;
  return `${s.slice(0, VERIFY_ECHO_LEN)}…`;
}

/**
 * Best-effort lookup of the simulator's installed-keyboards entry. We parse
 * `defaults read .GlobalPreferences AppleKeyboards` and return the first
 * entry that carries a `sw=…` token. This is *not* guaranteed to be the
 * currently active keyboard (per issue #39 addendum §1 iOS 26.4 exposes no
 * deterministic "active" signal), but it is the single most diagnostic
 * string a caller can attach to an ambiguous typing report — if the first
 * entry is `ko_KR@sw=Korean - 2 Set;hw=Automatic` and the readback is Jamo
 * gibberish, the root cause is obvious at a glance.
 */
async function detectKeyboardLayout(deviceId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'spawn', deviceId, 'defaults', 'read', '.GlobalPreferences', 'AppleKeyboards'],
      { timeout: 5000 },
    );
    const match = stdout.match(/"([^"]*@[^"]*sw=[^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function jsonError(error: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error, ...extra }) }],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
