/**
 * Keyboard-layout utilities for the simulator preflight path.
 *
 * Background — issue #39:
 *   `app_type_element` dispatches typed text through `sim-hid-bridge`, which
 *   sends raw HID usage codes under the assumption of a US-ABC keyboard. When
 *   the simulator's active software keyboard is non-Latin (Korean 2-벌식,
 *   Japanese かな, Chinese Pinyin, …) those keycodes are intercepted by the
 *   iOS input method and transliterated, silently corrupting the typed value.
 *
 * The "is the active layout safe for simhid typing?" question collapses to a
 * single assertion against the software-layout token encoded in the
 * `AppleKeyboards` preferences entry:
 *
 *     ko_KR@sw=Korean - 2 Set;hw=Automatic       — UNSAFE (IME will transliterate)
 *     en_US@sw=QWERTY;hw=Automatic               — SAFE
 *     en_GB@sw=QWERTY;hw=Automatic               — SAFE
 *     ja_JP@sw=Japanese-Kana;hw=Automatic        — UNSAFE
 *     zh_Hans@sw=Pinyin-Simplified;hw=Automatic  — UNSAFE
 *
 * Per issue #39 addendum §2 the load-bearing assertion is that the `sw=`
 * (software layout) token equals `QWERTY`. Every other part of the key —
 * locale prefix, `hw=` token, whitespace — is ignored.
 *
 * Limitation (issue #639 Problem 1):
 *   There is currently no documented way to programmatically switch the
 *   simulator's active input source from the host. When a non-Latin layout
 *   is detected and text diverges after HID typing, use
 *   `backend: "pasteboard"` to bypass the software keyboard entirely.
 */

/**
 * Pattern matching the `sw=<token>` fragment inside an `AppleKeyboards` entry.
 * The token runs until the next `;` (or end of string) and may contain spaces,
 * hyphens, or alphanumerics (e.g. `Korean - 2 Set`, `Pinyin-Simplified`).
 */
const SOFTWARE_LAYOUT_PATTERN = /(?:^|[;@])sw=([^;]+)/i;

/**
 * Extract the `sw=` token from an `AppleKeyboards` entry. Returns the raw
 * token (trimmed) or `null` when the entry has no software-layout fragment.
 *
 * Exported separately from `isLatinSoftwareLayout` so the probe helper and
 * the Tier-3 diagnostics field (`keyboard_layout_detected`) can surface the
 * same canonical value the matcher uses.
 */
export function extractSoftwareLayout(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  const match = SOFTWARE_LAYOUT_PATTERN.exec(key);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Return `true` when the given `AppleKeyboards` entry names a Latin/ABC
 * software layout — i.e. one whose `sw=` token is exactly `QWERTY` (case
 * insensitive). Returns `false` for every non-Latin layout and for malformed
 * inputs that don't expose a `sw=` token at all.
 *
 * The matcher is intentionally strict: `sw=QWERTY-Intl` or `sw=Dvorak` are
 * *not* treated as Latin, because their HID-usage mappings diverge from the
 * US-ABC assumption that `sim-hid-bridge` bakes in. If a future iOS release
 * adds another safe layout, widen this predicate explicitly rather than
 * substring-matching on `QWERTY`.
 */
export function isLatinSoftwareLayout(key: string): boolean {
  const token = extractSoftwareLayout(key);
  if (!token) return false;
  return token.toLowerCase() === 'qwerty';
}

/**
 * Max characters echoed for `expected` / `actual` in the hint payload.
 * These fields exist only to prove that HID typing transliterated the input —
 * a short prefix does that without shipping the full user value (emails,
 * tokens, passwords) through MCP error payloads / logs. Matches the
 * `VERIFY_ECHO_LEN` cap `app_type_element` uses in `verify_reason`.
 */
const HINT_ECHO_LEN = 24;

function truncateForHint(s: string): string {
  if (s.length <= HINT_ECHO_LEN) return s;
  return `${s.slice(0, HINT_ECHO_LEN)}…`;
}

/**
 * Structured hint returned by `mismatchHint()` when a non-Latin keyboard
 * layout is detected and HID-typed text diverges from the expected value.
 * Surface this as `isError: true` with this object as the error payload so
 * callers can programmatically choose the recommended remediation.
 *
 * `expected` / `actual` are truncated echoes (prefix + `…`) of the caller's
 * input and the AX readback — truncation is done by `mismatchHint` itself so
 * the hint never carries full user text through MCP logs / telemetry, and
 * `truncated: true` flags that the caller must not treat them as authoritative
 * text. The raw readback is only ever exposed via the tool's separate
 * `verify_reason` (which has matching truncation).
 */
export interface LayoutMismatchHint {
  code: 'TEXT_INPUT_LAYOUT_MISMATCH';
  expected: string;
  actual: string;
  truncated: boolean;
  suggestedBackend: 'pasteboard';
  detectedLayout?: string;
  /**
   * `detectedLayout` is the first `AppleKeyboards` entry with a `sw=` token,
   * which is heuristic — iOS 26.4 exposes no deterministic "active layout"
   * signal from the host (see module header). Callers should treat the
   * hint as "probably a layout transliteration problem" rather than a
   * verified active-layout claim.
   */
  layoutSource?: 'apple_keyboards_first_entry';
}

/**
 * Build a `TEXT_INPUT_LAYOUT_MISMATCH` hint for use by `app_type_element`
 * when post-typing readback diverges AND the detected keyboard layout is
 * non-Latin (issue #639 Problem 1).
 *
 * Returns `null` when the layout is Latin (or unknown) — callers must NOT
 * surface this error for Latin layouts, since divergence there indicates a
 * different failure mode (e.g. `TEXT_INPUT_DROPPED` from PR A).
 *
 * The returned `expected` / `actual` fields are truncated prefix echoes
 * (see `HINT_ECHO_LEN`). Full values are never included — callers that need
 * longer echoes should read the tool's `verify_reason`, which applies the
 * same cap.
 *
 * @param expected  The text the caller intended to type.
 * @param actual    The text observed in the AX readback.
 * @param detectedLayout  Raw `AppleKeyboards` entry (from `detectKeyboardLayout`).
 *                        May be `null` when the probe failed. Heuristic —
 *                        not guaranteed to be the currently active layout.
 */
export function mismatchHint(
  expected: string,
  actual: string,
  detectedLayout: string | null,
): LayoutMismatchHint | null {
  // Only fire for confirmed non-Latin layouts. When the layout is unknown
  // (detectedLayout === null) or is Latin-safe, return null — a different
  // error code (TEXT_INPUT_DROPPED) applies to the Latin mismatch case.
  if (!detectedLayout) return null;
  if (isLatinSoftwareLayout(detectedLayout)) return null;
  const truncated =
    expected.length > HINT_ECHO_LEN || actual.length > HINT_ECHO_LEN;
  const hint: LayoutMismatchHint = {
    code: 'TEXT_INPUT_LAYOUT_MISMATCH',
    expected: truncateForHint(expected),
    actual: truncateForHint(actual),
    truncated,
    suggestedBackend: 'pasteboard',
    detectedLayout,
    layoutSource: 'apple_keyboards_first_entry',
  };
  return hint;
}
