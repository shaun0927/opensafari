/**
 * localized-button-matcher -- unified corpus + extension seam for matching
 * localized iOS alert / permission-dialog button labels.
 *
 * ## Design
 *
 * Two consumers previously duplicated independent label lists:
 *   - `app-handle-alert-labels.ts`  (alert accept/dismiss corpus)
 *   - `pasteboard-input.ts`         (paste-permission corpus)
 *
 * This module centralises them under a typed `LabelKind` discriminant and
 * exposes `matchLabel()` / `registerLabels()` so downstream extensions can
 * inject app-specific or locale-specific labels at runtime without touching
 * this file (see `docs/recipes/localized-buttons.md`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Semantic category of a button label.
 *
 * - `'accept'`       General confirm / allow (location, notifications, ...).
 * - `'dismiss'`      Cancel / deny / "don't allow".
 * - `'accept-once'`  "Allow Once" -- time-scoped accept.
 * - `'paste-allow'`  Accept button on iOS paste-permission dialog.
 *
 * Extend with new string literals as new dialog categories emerge; all
 * existing call-sites remain valid because the type is a union.
 */
export type LabelKind = 'accept' | 'dismiss' | 'accept-once' | 'paste-allow';

// ---------------------------------------------------------------------------
// Unicode whitespace normalization
// ---------------------------------------------------------------------------

/**
 * Unicode whitespace codepoints frequently embedded in Apple's localized
 * SpringBoard strings to prevent line-wrapping. The corpus stores ASCII
 * U+0020 spaces; the runtime AX label may contain any of these variants:
 *
 * U+00A0  NO-BREAK SPACE
 * U+202F  NARROW NO-BREAK SPACE
 * U+2007  FIGURE SPACE
 * U+2060  WORD JOINER
 * U+2028  LINE SEPARATOR
 * U+2029  PARAGRAPH SEPARATOR
 */
const FANCY_WHITESPACE = new RegExp('[   ⁠  ]', 'g');

/**
 * NFC-normalise, collapse fancy Unicode spaces to ASCII space, trim, and
 * lowercase `text` so it can be compared against corpus entries.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(FANCY_WHITESPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Mutable corpus map -- kind => set of normalised label strings. */
const corpus = new Map<LabelKind, Set<string>>();

function addLabels(kind: LabelKind, labels: readonly string[]): void {
  if (!corpus.has(kind)) corpus.set(kind, new Set());
  const bucket = corpus.get(kind)!;
  for (const label of labels) {
    bucket.add(normalizeText(label));
  }
}

// -- Alert accept corpus (from app-handle-alert-labels.ts) ------------------
addLabels('accept', [
  // en
  'Allow',
  'OK',
  'Allow While Using App',
  'Allow All',
  'Continue',
  'Yes',
  'Open Settings',
  'Enable',
  // ko
  '허용',
  '확인',
  '앱을 사용하는 동안 허용',
  '계속',
  '설정 열기',
  '켜기',
  // ja
  '許可',
  '常に許可',
  '続ける',
  '設定を開く',
  // zh-Hans
  '允许',
  '好',
  '始终允许',
  '继续',
  '打开设置',
]);

// -- Accept-once corpus (from app-handle-alert-labels.ts) -------------------
addLabels('accept-once', [
  'Allow Once',
  '한 번 허용',
  '一度だけ許可',
  '仅允许一次',
]);

// -- Alert dismiss corpus (from app-handle-alert-labels.ts) -----------------
addLabels('dismiss', [
  // en
  "Don't Allow",
  'Cancel',
  'Deny',
  'Not Now',
  'Disable',
  // ko
  '허용 안 함',
  '취소',
  '나중에',
  // ja
  '許可しない',
  'キャンセル',
  '後で',
  // zh-Hans
  '不允许',
  '取消',
  '稍后',
]);

// -- Paste-permission accept corpus (from pasteboard-input.ts) ---------------
// Only unambiguous full phrases to avoid collisions with the accept corpus.
addLabels('paste-allow', [
  'allow paste',
  '붙여넣기 허용',
  '允许粘贴',
  '貼り付けを許可',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register additional labels for `kind` at runtime. Call this from your
 * per-app extension before the first call to `matchLabel()`.
 *
 * ```ts
 * import { registerLabels } from 'opensafari/tools/localized-button-matcher';
 *
 * registerLabels('accept', ['Yep', 'Grant Access', '承認']);
 * ```
 *
 * Labels are NFC-normalised and lowercased on registration, so you can pass
 * display-cased strings directly.
 */
export function registerLabels(kind: LabelKind, labels: string[]): void {
  addLabels(kind, labels);
}

/**
 * Match `text` against the combined corpus using a case-insensitive,
 * NFC-normalised **substring** test.
 *
 * Returns the `LabelKind` of the first matching bucket (order: accept-once,
 * paste-allow, dismiss, accept) or `null` when no corpus entry is a substring
 * of `text`. More-specific kinds are checked before the broad `accept` bucket.
 * Within each bucket, longer entries are tested before shorter ones so that
 * specific phrases (e.g. "허용 안 함") win over short substrings (e.g. "허용").
 *
 * @param text - Raw AX button label from the running app.
 */
export function matchLabel(text: string): LabelKind | null {
  const normalized = normalizeText(text);
  const order: LabelKind[] = ['accept-once', 'paste-allow', 'dismiss', 'accept'];
  for (const kind of order) {
    const bucket = corpus.get(kind);
    if (!bucket) continue;
    // Longer entries first so specific phrases beat short substrings.
    const entries = Array.from(bucket).sort((a, b) => b.length - a.length);
    for (const entry of entries) {
      if (normalized.includes(entry)) {
        return kind;
      }
    }
  }
  return null;
}

/**
 * Read-only snapshot of the current corpus for a given kind.
 * Intended for testing and diagnostics only.
 */
export function getCorpusSnapshot(kind: LabelKind): string[] {
  return Array.from(corpus.get(kind) ?? []);
}
