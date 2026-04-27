/**
 * pasteboard-input — Unicode-safe text injection via the iOS Simulator pasteboard.
 *
 * Typing through the `simhid` HID path is bound to the US keyboard layout and
 * silently transliterates through any non-Latin software keyboard active on the
 * target simulator (see issue #39). This helper bypasses the software keyboard
 * entirely:
 *
 *   1. Save the simulator's current pasteboard (for later restore).
 *   2. Write the desired `text` to the simulator pasteboard via
 *      `xcrun simctl pbcopy <udid>`.
 *   3. Press Cmd+V via the sim-hid bridge's `key-mod` subcommand.
 *   4. If iOS surfaces a paste-permission dialog ("Allow Paste" / "붙여넣기 허용"),
 *      optionally auto-accept it.
 *   5. Restore the original pasteboard.
 *
 * Works for any Unicode input (Latin, CJK, emoji) regardless of which software
 * keyboard is currently active on the simulator. Requires:
 *   - A booted iOS Simulator (`simctl pbcopy` needs `Booted` state).
 *   - The `sim-hid-bridge` helper (SimulatorKit-backed).
 *   - Simulator's "Connect Hardware Keyboard" preference enabled (default on).
 *
 * The caller is responsible for focusing the target element *before* invoking
 * `typeViaPasteboard`; this helper does not tap.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  SimulatorKitHIDInputBackend,
  tryCreateSimulatorKitHIDBackend,
  InputBackendError,
} from './sim-hid-input-backend';
import { getAccessibilityBridge } from '../native';
import { matchLabel as matchButtonLabel } from './localized-button-matcher';

const execFileAsync = promisify(execFile);

/** HID usages for the Cmd+V chord (Keyboard/Keypad page 0x07). */
const HID_USAGE_V = 0x19;
const HID_USAGE_LEFT_GUI = 0xe3;

export type PermissionDialogOutcome =
  | 'not_shown'
  | 'auto_accepted'
  | 'not_accepted';

export interface PasteNotAppliedError {
  code: 'PASTE_NOT_APPLIED';
  expected: string;
  actual: string | undefined;
  permissionDialogObserved: boolean;
}

/**
 * Compares the post-paste AX value against the expected payload and throws a
 * structured `PASTE_NOT_APPLIED` error when the paste did not land. Pure
 * function so the readback contract can be unit-tested without mocking the
 * accessibility bridge or the simulator pasteboard.
 *
 * The "applied" predicate accepts either an exact suffix match or a substring
 * match because some text fields prepend placeholder text to the value, and
 * IME composition state can leave the cursor mid-string.
 *
 * `actual === undefined` (bridge readback failed) is treated as inconclusive
 * and does NOT throw — we cannot distinguish "paste failed" from "bridge
 * unavailable" in that case.
 */
export function assertPasteApplied(
  actual: string | undefined,
  expected: string,
  permissionDialogObserved: boolean,
): void {
  if (actual === undefined || actual === null) return;
  const applied = actual.endsWith(expected) || actual.includes(expected);
  if (applied) return;
  const err: PasteNotAppliedError = {
    code: 'PASTE_NOT_APPLIED',
    expected,
    actual,
    permissionDialogObserved,
  };
  throw Object.assign(new Error('PASTE_NOT_APPLIED'), err);
}

export interface PasteboardTypeResult {
  backend: 'pasteboard';
  length: number;
  pasteboardRestored: boolean;
  permissionDialog: PermissionDialogOutcome;
  permissionDialogMatchedLabel?: string;
  elapsedMs: number;
}

export interface PasteboardTypeOptions {
  /** Restore the simulator pasteboard to its pre-call value. Default: true. */
  restorePasteboard?: boolean;
  /** Auto-accept the paste-permission dialog if it appears. Default: true. */
  autoAcceptPastePermission?: boolean;
  /** Ms to wait after Cmd+V before scanning for the permission dialog. Default: 500. */
  pasteSettleMs?: number;
  /** Max ms to poll for the paste-permission dialog. Default: 1500. */
  permissionDialogTimeoutMs?: number;
  /** Ms between AX polls while waiting for the permission dialog. Default: 150. */
  permissionDialogPollMs?: number;
  /** Injected backend (for tests). Default: auto-resolve via `tryCreateSimulatorKitHIDBackend`. */
  backend?: SimulatorKitHIDInputBackend;
  /**
   * The text that was placed on the pasteboard. When provided, `typeViaPasteboard`
   * reads back the focused element's AX value after `pasteSettleMs` and returns a
   * structured `PasteNotAppliedError` if the field does not contain the expected
   * text. Omit to skip verification (legacy behaviour).
   */
  expected?: string;
  /**
   * AX path of the focused element. Required for readback verification; ignored
   * when `expected` is not set.
   */
  focusedElementPath?: string;
}

/**
 * Type `text` into the currently-focused element by round-tripping through the
 * iOS Simulator pasteboard. See module doc for sequence + preconditions.
 */
export async function typeViaPasteboard(
  deviceId: string,
  text: string,
  options: PasteboardTypeOptions = {},
): Promise<PasteboardTypeResult> {
  const startedAt = Date.now();
  const restorePasteboard = options.restorePasteboard ?? true;
  const autoAcceptPermission = options.autoAcceptPastePermission ?? true;
  const pasteSettleMs = options.pasteSettleMs ?? 500;
  const permissionDialogTimeoutMs = options.permissionDialogTimeoutMs ?? 1500;
  const permissionDialogPollMs = options.permissionDialogPollMs ?? 150;

  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('typeViaPasteboard: text must be a non-empty string');
  }

  const backend = options.backend ?? (await tryCreateSimulatorKitHIDBackend());
  if (!backend) {
    throw new InputBackendError(
      'typeViaPasteboard requires the sim-hid-bridge helper (not found). ' +
        'Run `npm run build` or ensure dist/sim-hid-bridge is present.',
      'HID_BRIDGE_MISSING',
    );
  }

  const originalPasteboard = restorePasteboard
    ? await safeReadPasteboard(deviceId)
    : null;

  await writePasteboard(deviceId, text);
  await backend.keyChord(deviceId, HID_USAGE_V, HID_USAGE_LEFT_GUI);

  await sleep(pasteSettleMs);

  let permissionDialog: PermissionDialogOutcome = 'not_shown';
  let permissionDialogMatchedLabel: string | undefined;
  let permissionDialogObserved = false;
  if (autoAcceptPermission) {
    const match = await pollForPermissionDialog(
      deviceId,
      permissionDialogTimeoutMs,
      permissionDialogPollMs,
    );
    if (match) {
      permissionDialogObserved = true;
      const pressed = await tryPressPermissionButton(deviceId, match.path);
      permissionDialog = pressed ? 'auto_accepted' : 'not_accepted';
      permissionDialogMatchedLabel = match.label;
    }
  }

  let pasteboardRestored = false;
  if (restorePasteboard && originalPasteboard !== null) {
    try {
      await writePasteboard(deviceId, originalPasteboard);
      pasteboardRestored = true;
    } catch {
      pasteboardRestored = false;
    }
  }

  // Readback verification: if the caller supplied the expected payload and an
  // element path, re-read the AX value and confirm the paste landed.
  const { expected, focusedElementPath } = options;
  if (expected !== undefined && focusedElementPath) {
    const bridge = getAccessibilityBridge();
    let actual: string | undefined;
    try {
      const node = await bridge.inspect(focusedElementPath, deviceId);
      actual = node.value;
    } catch {
      // Bridge error — treat as unknown; do not surface PASTE_NOT_APPLIED
      // because we cannot distinguish "paste failed" from "bridge unavailable".
    }
    assertPasteApplied(actual, expected, permissionDialogObserved);
  }

  return {
    backend: 'pasteboard',
    length: text.length,
    pasteboardRestored,
    permissionDialog,
    permissionDialogMatchedLabel,
    elapsedMs: Date.now() - startedAt,
  };
}

async function safeReadPasteboard(deviceId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'pbpaste', deviceId], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5000,
    });
    return stdout ?? '';
  } catch {
    return null;
  }
}

function writePasteboard(deviceId: string, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      'xcrun',
      ['simctl', 'pbcopy', deviceId],
      { timeout: 5000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    if (!child.stdin) {
      reject(new Error('simctl pbcopy: child stdin unavailable'));
      return;
    }
    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(text);
    child.stdin.end();
  });
}

interface PermissionDialogMatch {
  path: string;
  label: string;
}

async function pollForPermissionDialog(
  deviceId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<PermissionDialogMatch | null> {
  const bridge = getAccessibilityBridge();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await bridge.query({ role: 'AXButton' }, { deviceId });
      for (const match of result.matches) {
        const label = match.label ?? '';
        if (!label) continue;
        // Delegate paste-allow matching to localized-button-matcher so the
        // corpus is maintained in one place and can be extended via registerLabels().
        if (matchButtonLabel(label) === 'paste-allow') {
          return { path: match.path, label };
        }
      }
    } catch {
      /* ignore — tree may be mid-transition */
    }
    await sleep(pollMs);
  }
  return null;
}

async function tryPressPermissionButton(deviceId: string, path: string): Promise<boolean> {
  const bridge = getAccessibilityBridge();
  try {
    const result = await bridge.press(path, deviceId);
    return result.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
