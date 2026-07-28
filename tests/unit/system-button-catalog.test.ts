import {
  resolveSemanticLabel,
  SYSTEM_BUTTON_CATALOG,
  SemanticButtonKey,
  SupportedLocale,
} from '../../src/native/system-button-catalog';

const newSemanticKeys: SemanticButtonKey[] = [
  'storekit.confirm',
  'storekit.buy',
  'storekit.subscribe',
  'testflight.install',
  'testflight.update',
  'testflight.open',
  'testflight.signIn',
];

const supportedLocales: SupportedLocale[] = ['en', 'ko', 'ja', 'zh-Hans'];

const expectedEnglishLabels = {
  'storekit.confirm': 'Confirm',
  'storekit.buy': 'Buy',
  'storekit.subscribe': 'Subscribe',
  'testflight.install': 'Install',
  'testflight.update': 'Update',
  'testflight.open': 'Open',
  'testflight.signIn': 'Sign In',
  'storekit.cancel': 'Cancel',
} satisfies Partial<Record<SemanticButtonKey, string>>;

describe('system button catalog', () => {
  test('resolves StoreKit and TestFlight labels for every supported locale', () => {
    for (const key of newSemanticKeys) {
      for (const locale of supportedLocales) {
        expect(resolveSemanticLabel(key, locale)).toBe(
          SYSTEM_BUTTON_CATALOG[key][locale],
        );
        expect(resolveSemanticLabel(key, locale)).toEqual(expect.any(String));
        expect(resolveSemanticLabel(key, locale).length).toBeGreaterThan(0);
      }
    }
  });

  test('uses the requested English StoreKit and TestFlight button labels', () => {
    for (const [key, label] of Object.entries(expectedEnglishLabels)) {
      expect(resolveSemanticLabel(key as SemanticButtonKey, 'en')).toBe(label);
    }
  });

  test('falls back to English for unsupported locales', () => {
    const keys = [...newSemanticKeys, 'storekit.cancel'] as SemanticButtonKey[];
    for (const key of keys) {
      expect(resolveSemanticLabel(key, 'fr-FR')).toBe(
        SYSTEM_BUTTON_CATALOG[key].en,
      );
    }
  });
});
