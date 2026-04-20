import {
  extractSoftwareLayout,
  isLatinSoftwareLayout,
} from '../../src/tools/keyboard-layout';

describe('isLatinSoftwareLayout', () => {
  describe('Latin layouts (sw=QWERTY) — accepted', () => {
    const latin = [
      'en_US@sw=QWERTY;hw=Automatic',
      'en_US@hw=US;sw=QWERTY',
      'en_GB@sw=QWERTY;hw=Automatic',
      'de_DE@sw=QWERTY;hw=Automatic',
      'en_US@sw=qwerty;hw=Automatic',
      'en_US@sw=QWERTY',
    ];
    for (const key of latin) {
      it(`accepts "${key}"`, () => {
        expect(isLatinSoftwareLayout(key)).toBe(true);
      });
    }
  });

  describe('non-Latin layouts — rejected', () => {
    const nonLatin = [
      'ko_KR@sw=Korean - 2 Set;hw=Automatic',
      'ko_KR@sw=Korean - 3 Set (390);hw=Automatic',
      'ja_JP@sw=Japanese-Kana;hw=Automatic',
      'ja_JP@sw=Japanese-Romaji;hw=Automatic',
      'zh_Hans@sw=Pinyin-Simplified;hw=Automatic',
      'zh_Hant@sw=Cangjie;hw=Automatic',
      'ru_RU@sw=Russian;hw=Automatic',
      'ar@sw=Arabic;hw=Automatic',
    ];
    for (const key of nonLatin) {
      it(`rejects "${key}"`, () => {
        expect(isLatinSoftwareLayout(key)).toBe(false);
      });
    }
  });

  describe('Latin-adjacent but not QWERTY — rejected', () => {
    const latinAdjacent = [
      'en_US@sw=Dvorak;hw=Automatic',
      'en_US@sw=Colemak;hw=Automatic',
      'en_US@sw=QWERTY-Intl;hw=Automatic',
      'fr_FR@sw=AZERTY;hw=Automatic',
    ];
    for (const key of latinAdjacent) {
      it(`rejects "${key}" (simhid HID mapping assumes US-QWERTY exactly)`, () => {
        expect(isLatinSoftwareLayout(key)).toBe(false);
      });
    }
  });

  describe('malformed input', () => {
    it('rejects empty string', () => {
      expect(isLatinSoftwareLayout('')).toBe(false);
    });
    it('rejects entries with no sw= token', () => {
      expect(isLatinSoftwareLayout('en_US@hw=Automatic')).toBe(false);
    });
    it('rejects entries with empty sw= token', () => {
      expect(isLatinSoftwareLayout('en_US@sw=;hw=Automatic')).toBe(false);
    });
    it('rejects non-string input', () => {
      expect(isLatinSoftwareLayout(null as unknown as string)).toBe(false);
      expect(isLatinSoftwareLayout(undefined as unknown as string)).toBe(false);
    });
  });
});

describe('extractSoftwareLayout', () => {
  it('extracts the token when `@sw=` is the prefix form', () => {
    expect(extractSoftwareLayout('en_US@sw=QWERTY;hw=Automatic')).toBe('QWERTY');
  });

  it('extracts the token when `;sw=` is positioned after another segment', () => {
    expect(extractSoftwareLayout('en_US@hw=US;sw=QWERTY')).toBe('QWERTY');
  });

  it('preserves spaces and hyphens inside tokens', () => {
    expect(extractSoftwareLayout('ko_KR@sw=Korean - 2 Set;hw=Automatic')).toBe(
      'Korean - 2 Set',
    );
    expect(extractSoftwareLayout('zh_Hans@sw=Pinyin-Simplified;hw=Automatic')).toBe(
      'Pinyin-Simplified',
    );
  });

  it('returns null when no sw= token is present', () => {
    expect(extractSoftwareLayout('en_US@hw=Automatic')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractSoftwareLayout('')).toBeNull();
  });

  it('returns null for empty sw= token', () => {
    expect(extractSoftwareLayout('en_US@sw=;hw=Automatic')).toBeNull();
  });
});
