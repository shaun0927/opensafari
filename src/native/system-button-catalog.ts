/**
 * System Button Catalog
 *
 * Seed catalog mapping semantic button keys to their localized labels
 * for common iOS system sheets and alerts.
 *
 * Locale coverage: en (English), ko (Korean), ja (Japanese), zh-Hans (Simplified Chinese).
 *
 * Usage: look up a semantic key to get the ordered list of label candidates
 * for a given locale, then pass them as `buttonLabels` to `app_alert_handle`.
 */

/** Supported locale identifiers. */
export type SupportedLocale = 'en' | 'ko' | 'ja' | 'zh-Hans';

/** Per-locale string map for a single semantic button key. */
export type LocalizedButtonEntry = Record<SupportedLocale, string>;

/** All semantic button keys defined in this catalog. */
export type SemanticButtonKey =
  | 'storekit.signIn'
  | 'storekit.cancel'
  | 'storekit.confirm'
  | 'storekit.buy'
  | 'storekit.subscribe'
  | 'testflight.install'
  | 'testflight.update'
  | 'testflight.open'
  | 'testflight.signIn'
  | 'alert.ok'
  | 'alert.cancel'
  | 'permission.allow'
  | 'permission.deny'
  | 'permission.whileUsing'
  | 'settings.open'
  | 'settings.cancel';

/**
 * Catalog mapping semantic keys → localized button labels.
 *
 * Sources:
 *   - StoreKit: Apple Developer docs, iOS 17 StoreKit2 payment sheets
 *   - Alert / Permission: iOS UIAlertController system strings
 *   - Settings: iOS "Open Settings" sheet strings
 */
export const SYSTEM_BUTTON_CATALOG: Record<SemanticButtonKey, LocalizedButtonEntry> = {
  'storekit.signIn': {
    en: 'Sign In',
    ko: '로그인',
    ja: 'サインイン',
    'zh-Hans': '登录',
  },
  'storekit.cancel': {
    en: 'Cancel',
    ko: '취소',
    ja: 'キャンセル',
    'zh-Hans': '取消',
  },
  'storekit.confirm': {
    en: 'Confirm',
    ko: '확인',
    ja: '確認',
    'zh-Hans': '确认',
  },
  'storekit.buy': {
    en: 'Buy',
    ko: '구입',
    ja: '購入',
    'zh-Hans': '购买',
  },
  'storekit.subscribe': {
    en: 'Subscribe',
    ko: '구독',
    ja: '登録',
    'zh-Hans': '订阅',
  },
  'testflight.install': {
    en: 'Install',
    ko: '설치',
    ja: 'インストール',
    'zh-Hans': '安装',
  },
  'testflight.update': {
    en: 'Update',
    ko: '업데이트',
    ja: 'アップデート',
    'zh-Hans': '更新',
  },
  'testflight.open': {
    en: 'Open',
    ko: '열기',
    ja: '開く',
    'zh-Hans': '打开',
  },
  'testflight.signIn': {
    en: 'Sign In',
    ko: '로그인',
    ja: 'サインイン',
    'zh-Hans': '登录',
  },
  'alert.ok': {
    en: 'OK',
    ko: '확인',
    ja: 'OK',
    'zh-Hans': '好',
  },
  'alert.cancel': {
    en: 'Cancel',
    ko: '취소',
    ja: 'キャンセル',
    'zh-Hans': '取消',
  },
  'permission.allow': {
    en: 'Allow',
    ko: '허용',
    ja: '許可',
    'zh-Hans': '允许',
  },
  'permission.deny': {
    en: "Don't Allow",
    ko: '허용 안 함',
    ja: '許可しない',
    'zh-Hans': '不允许',
  },
  'permission.whileUsing': {
    en: 'Allow While Using App',
    ko: '앱을 사용하는 동안 허용',
    ja: 'Appの使用中は許可',
    'zh-Hans': 'App使用期间允许',
  },
  'settings.open': {
    en: 'Settings',
    ko: '설정',
    ja: '設定',
    'zh-Hans': '设置',
  },
  'settings.cancel': {
    en: 'Cancel',
    ko: '취소',
    ja: 'キャンセル',
    'zh-Hans': '取消',
  },
};

/**
 * Resolve the localized label for a semantic key and locale.
 *
 * Falls back to English when the requested locale is not in the catalog.
 *
 * @param key    Semantic button key (e.g. 'alert.ok')
 * @param locale Locale identifier (e.g. 'ko', 'ja', 'zh-Hans')
 * @returns      Localized label string
 */
export function resolveSemanticLabel(
  key: SemanticButtonKey,
  locale: string,
): string {
  const entry = SYSTEM_BUTTON_CATALOG[key];
  const supported = locale as SupportedLocale;
  return entry[supported] ?? entry['en'];
}
