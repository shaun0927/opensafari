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

export function matchLabel(
  text: string,
  action: AlertAction,
): { locale: AlertLocale; label: string } | null {
  const trimmed = text.trim().toLowerCase();
  const localeMap = ALL_LABELS[action];
  for (const locale of Object.keys(localeMap) as AlertLocale[]) {
    for (const label of localeMap[locale]) {
      if (label.toLowerCase() === trimmed) {
        return { locale, label };
      }
    }
  }
  return null;
}
