/**
 * src/tools/app-handle-alert-labels.ts
 *
 * Locale-aware label corpus for the `app_handle_alert` MCP tool.
 *
 * Source of truth: `app-handle-alert-labels.generated.json`, produced by
 *   scripts/dev/dump-springboard-permission-strings.ts
 * against the iOS simruntime bundled on the build machine.
 *
 * We union the generated corpus with a small hand-curated baseline below
 * (covering the four originally-supported locales: en, ko, ja, zh-Hans).
 * The baseline picks up labels that don't appear verbatim in TCC/CoreIDV
 * strings — specifically the CoreLocation "Allow Once" / "Allow While
 * Using App" / "Not Now" / "Open Settings" variants — so that handle-alert
 * keeps recognising them even on runtimes that haven't shipped those keys
 * under the scraped prefixes yet. Generated values win on duplicates.
 *
 * See `docs/contributing.md` for when/how to regenerate the JSON.
 */

import generated from './app-handle-alert-labels.generated.json';

export type AlertAction = 'accept' | 'dismiss';

/**
 * Runtime-widened locale tag. The set of valid values is defined by the keys
 * in the generated JSON plus the baseline below. We expose it as `string`
 * (rather than a computed literal union) for two reasons:
 *
 *   1. The generated JSON can grow on every iOS release and we don't want to
 *      regenerate a `.d.ts` file alongside it.
 *   2. Call sites either iterate over `Object.keys(ALL_LABELS[action])` or
 *      receive a locale value that was produced by this module; neither
 *      benefits from a closed literal union.
 *
 * `matchLabel()` returns the specific tag that matched (e.g. "ko", "pt-BR").
 */
export type AlertLocale = string;

export interface AlertLabel {
  display: string;
  locale: AlertLocale;
  axIdentifier?: string;
}

// ---------------------------------------------------------------------------
// Hand-curated baseline for the four originally-supported locales. These
// preserve the labels shipped by issue #43 (CoreLocation / generic system
// dialogs) that are not necessarily reachable via the TCC scrape.
//
// Do NOT expand this baseline to cover more locales — the generated JSON is
// the source of truth for everything except these four. Additions here are
// only appropriate if a label appears on a live iOS system-dialog prompt
// *and* the regenerated corpus doesn't pick it up.
// ---------------------------------------------------------------------------

const BASELINE_ACCEPT: Record<string, string[]> = {
  en: [
    'Allow',
    'OK',
    'Allow Once',
    'Allow While Using App',
    'Allow All',
    'Continue',
    'Yes',
    'Open Settings',
    'Enable',
  ],
  ko: ['허용', '확인', '한 번 허용', '앱을 사용하는 동안 허용', '계속', '설정 열기', '켜기'],
  ja: ['許可', 'OK', '常に許可', '一度だけ許可', '続ける', '設定を開く'],
  'zh-Hans': ['允许', '好', '始终允许', '仅允许一次', '继续', '打开设置'],
};

const BASELINE_DISMISS: Record<string, string[]> = {
  en: ["Don't Allow", 'Cancel', 'Deny', 'Not Now', 'Disable'],
  ko: ['허용 안 함', '취소', '나중에'],
  ja: ['許可しない', 'キャンセル', '後で'],
  'zh-Hans': ['不允许', '取消', '稍后'],
};

// ---------------------------------------------------------------------------
// Merge: start from the baseline, then let the generated JSON add/augment
// every locale. Generated values "win" in the sense that they are always
// included; we still keep baseline entries so that hand-curated labels
// (e.g. iOS CoreLocation's "Allow Once") survive even if the scrape changes.
// ---------------------------------------------------------------------------

interface GeneratedLocales {
  _generated?: unknown;
  runtime?: string;
  locales: Record<string, { accept: string[]; dismiss: string[] }>;
}

function mergeBaseline(
  base: Record<string, string[]>,
  generatedByLocale: Record<string, { accept: string[]; dismiss: string[] }>,
  field: 'accept' | 'dismiss',
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const locales = new Set<string>([...Object.keys(base), ...Object.keys(generatedByLocale)]);
  for (const locale of locales) {
    const seen = new Set<string>();
    const list: string[] = [];
    // Baseline first (keeps original ordering for the four seeded locales).
    for (const label of base[locale] ?? []) {
      if (!seen.has(label)) {
        seen.add(label);
        list.push(label);
      }
    }
    // Generated values win on conflicts by virtue of de-duplication: any
    // string already contributed by the baseline stays; new ones are added.
    for (const label of generatedByLocale[locale]?.[field] ?? []) {
      if (!seen.has(label)) {
        seen.add(label);
        list.push(label);
      }
    }
    out[locale] = list;
  }
  return out;
}

const GEN = generated as GeneratedLocales;

export const ACCEPT_LABELS: Record<AlertLocale, string[]> = mergeBaseline(
  BASELINE_ACCEPT,
  GEN.locales,
  'accept',
);

export const DISMISS_LABELS: Record<AlertLocale, string[]> = mergeBaseline(
  BASELINE_DISMISS,
  GEN.locales,
  'dismiss',
);

export const ALL_LABELS: Record<AlertAction, Record<AlertLocale, string[]>> = {
  accept: ACCEPT_LABELS,
  dismiss: DISMISS_LABELS,
};

export function flattenLabels(action: AlertAction): string[] {
  const localeMap = ALL_LABELS[action];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const locale of Object.keys(localeMap)) {
    for (const label of localeMap[locale]) {
      if (!seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
  }
  return result;
}

export function matchLabel(
  text: string,
  action: AlertAction,
): { locale: AlertLocale; label: string } | null {
  const trimmed = text.trim().toLowerCase();
  const localeMap = ALL_LABELS[action];
  for (const locale of Object.keys(localeMap)) {
    for (const label of localeMap[locale]) {
      if (label.toLowerCase() === trimmed) {
        return { locale, label };
      }
    }
  }
  return null;
}
