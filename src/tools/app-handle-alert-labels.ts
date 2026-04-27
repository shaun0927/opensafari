export type AlertAction = 'accept' | 'dismiss';
export type AlertLocale = 'en' | 'ko' | 'ja' | 'zh-Hans';

export interface AlertLabel {
  display: string;
  locale: AlertLocale;
  axIdentifier?: string;
}

export const ACCEPT_LABELS: Record<AlertLocale, string[]> = {
  en: ['Allow', 'OK', 'Allow Once', 'Allow While Using App', 'Allow All', 'Continue', 'Yes', 'Open Settings', 'Enable'],
  ko: ['허용', '확인', '한 번 허용', '앱을 사용하는 동안 허용', '계속', '설정 열기', '켜기'],
  ja: ['許可', 'OK', '常に許可', '一度だけ許可', '続ける', '設定を開く'],
  'zh-Hans': ['允许', '好', '始终允许', '仅允许一次', '继续', '打开设置'],
};

export const DISMISS_LABELS: Record<AlertLocale, string[]> = {
  en: ["Don't Allow", 'Cancel', 'Deny', 'Not Now', 'Disable'],
  ko: ['허용 안 함', '취소', '나중에'],
  ja: ['許可しない', 'キャンセル', '後で'],
  'zh-Hans': ['不允许', '取消', '稍后'],
};

export const ALL_LABELS: Record<AlertAction, Record<AlertLocale, string[]>> = {
  accept: ACCEPT_LABELS,
  dismiss: DISMISS_LABELS,
};

export function flattenLabels(action: AlertAction): string[] {
  const localeMap = ALL_LABELS[action];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const locale of Object.keys(localeMap) as AlertLocale[]) {
    for (const label of localeMap[locale]) {
      if (!seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
  }
  return result;
}

// Unicode whitespace codepoints frequently embedded in Apple's localized
// SpringBoard strings to prevent line-wrapping. The corpus stores ASCII
// U+0020 spaces, while the runtime AX label may contain any of these
// "fancy" spaces. Equality must compare normalized forms.
//
// U+00A0 NO-BREAK SPACE
// U+202F NARROW NO-BREAK SPACE
// U+2007 FIGURE SPACE
// U+2060 WORD JOINER
// U+2028 LINE SEPARATOR
// U+2029 PARAGRAPH SEPARATOR
const FANCY_WHITESPACE = /[\u00A0\u202F\u2007\u2060\u2028\u2029]/g;

export function normalizeLabel(text: string): string {
  return text
    .normalize('NFC')
    .replace(FANCY_WHITESPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchLabel(
  text: string,
  action: AlertAction,
): { locale: AlertLocale; label: string } | null {
  const normalized = normalizeLabel(text);
  const localeMap = ALL_LABELS[action];
  for (const locale of Object.keys(localeMap) as AlertLocale[]) {
    for (const label of localeMap[locale]) {
      if (normalizeLabel(label) === normalized) {
        return { locale, label };
      }
    }
  }
  return null;
}

/**
 * Extension seam for downstream apps that surface custom localized labels
 * (e.g. Apple Intelligence onboarding banners or app-specific permission
 * sheets that this corpus does not yet classify).
 *
 * Added labels participate in `matchLabel()` and `flattenLabels()` immediately;
 * existing entries are deduplicated by exact string match. See
 * `docs/recipes/localized-buttons.md` for usage patterns.
 */
export function registerExtraLabels(
  action: AlertAction,
  locale: AlertLocale,
  labels: readonly string[],
): void {
  const bucket = ALL_LABELS[action][locale];
  for (const label of labels) {
    if (!bucket.includes(label)) {
      bucket.push(label);
    }
  }
}
