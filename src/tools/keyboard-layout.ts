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
