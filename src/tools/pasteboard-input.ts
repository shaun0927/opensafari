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

const execFileAsync = promisify(execFile);

/** HID usages for the Cmd+V chord (Keyboard/Keypad page 0x07). */
const HID_USAGE_V = 0x19;
const HID_USAGE_LEFT_GUI = 0xe3;

/**
 * Label corpus for the iOS paste-permission dialog. Matched case-insensitively
 * via substring against `AXButton.label`. Extend per-locale as needed; keep the
 * list small to avoid collisions with legitimate in-app buttons.
 */
const ACCEPT_PASTE_LABELS = [
  'allow paste',
  'paste',
  '붙여넣기 허용',
  '허용',
  '允许粘贴',
  '允许',
  '貼り付けを許可',
  '許可',
] as const;

/**
 * Negative exclusions — substrings that flip an otherwise-accept-looking label
 * into a dismiss action. Evaluated case-insensitively; if any match, the
 * candidate is rejected even if it also matches an accept hint (e.g.
 * "붙여넣기 허용 안 함" matches "허용" but "안 함" disqualifies it).
 */
const DISMISS_SUBSTRINGS = [
  "don't",
  'do not',
  '안 함',
  '안함',
  '취소',
  'cancel',
  'キャンセル',
  '不允许',
  '取消',
  '拒绝',
] as const;

export type PermissionDialogOutcome =
  | 'not_shown'
  | 'auto_accepted'
  | 'not_accepted';

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
  if (autoAcceptPermission) {
    const match = await pollForPermissionDialog(
      deviceId,
      permissionDialogTimeoutMs,
      permissionDialogPollMs,
    );
    if (match) {
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
        const label = (match.label ?? '').toLowerCase();
        if (!label) continue;
        if (DISMISS_SUBSTRINGS.some((s) => label.includes(s.toLowerCase()))) {
          continue;
        }
        for (const hint of ACCEPT_PASTE_LABELS) {
          if (label.includes(hint.toLowerCase())) {
            return { path: match.path, label: match.label ?? hint };
          }
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
