import {
  ACCEPT_LABELS,
  DISMISS_LABELS,
  ALL_LABELS,
  flattenLabels,
  matchLabel,
  normalizeLabel,
  registerExtraLabels,
  type AlertLocale,
} from '../../src/tools/app-handle-alert-labels';

const LOCALES: AlertLocale[] = ['en', 'ko', 'ja', 'zh-Hans'];

describe('app-handle-alert-labels corpus', () => {
  describe('every locale has at least one accept label', () => {
    for (const locale of LOCALES) {
      test(locale, () => {
        expect(ACCEPT_LABELS[locale].length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe('every locale has at least one dismiss label', () => {
    for (const locale of LOCALES) {
      test(locale, () => {
        expect(DISMISS_LABELS[locale].length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe('no duplicate strings within a (locale, action) bucket', () => {
    for (const locale of LOCALES) {
      test(`accept/${locale}`, () => {
        const labels = ACCEPT_LABELS[locale];
        const unique = new Set(labels);
        expect(unique.size).toBe(labels.length);
      });

      test(`dismiss/${locale}`, () => {
        const labels = DISMISS_LABELS[locale];
        const unique = new Set(labels);
        expect(unique.size).toBe(labels.length);
      });
    }
  });

  test('ALL_LABELS contains both accept and dismiss keys', () => {
    expect(ALL_LABELS.accept).toBe(ACCEPT_LABELS);
    expect(ALL_LABELS.dismiss).toBe(DISMISS_LABELS);
  });

  test('flattenLabels("accept") returns unique strings across all locales', () => {
    const flat = flattenLabels('accept');
    const unique = new Set(flat);
    expect(unique.size).toBe(flat.length);
    expect(flat.length).toBeGreaterThan(0);
  });

  test('flattenLabels("dismiss") returns unique strings across all locales', () => {
    const flat = flattenLabels('dismiss');
    const unique = new Set(flat);
    expect(unique.size).toBe(flat.length);
    expect(flat.length).toBeGreaterThan(0);
  });

  test('matchLabel("한 번 허용", "accept") returns {locale:"ko", label:"한 번 허용"}', () => {
    const result = matchLabel('한 번 허용', 'accept');
    expect(result).toEqual({ locale: 'ko', label: '한 번 허용' });
  });

  test('matchLabel("  Allow  ", "accept") trims and matches en label', () => {
    const result = matchLabel('  Allow  ', 'accept');
    expect(result).toEqual({ locale: 'en', label: 'Allow' });
  });

  test('matchLabel is case-insensitive for ASCII', () => {
    const result = matchLabel('allow', 'accept');
    expect(result).toEqual({ locale: 'en', label: 'Allow' });
  });

  test('matchLabel("Cancel", "accept") returns null (Cancel is a dismiss label)', () => {
    const result = matchLabel('Cancel', 'accept');
    expect(result).toBeNull();
  });

  test('matchLabel("random", "accept") returns null', () => {
    const result = matchLabel('random', 'accept');
    expect(result).toBeNull();
  });

  describe('Unicode whitespace normalization (issue #642)', () => {
    const NBSP = ' ';
    const NNBSP = ' ';
    const FIGURE_SPACE = ' ';
    const WORD_JOINER = '⁠';

    test('matchLabel matches NBSP-separated ko dismiss label', () => {
      const input = `허용${NBSP}안${NBSP}함`;
      const result = matchLabel(input, 'dismiss');
      expect(result).toEqual({ locale: 'ko', label: '허용 안 함' });
    });

    test('matchLabel matches Narrow-NBSP-separated ko dismiss label', () => {
      const input = `허용${NNBSP}안${NNBSP}함`;
      const result = matchLabel(input, 'dismiss');
      expect(result).toEqual({ locale: 'ko', label: '허용 안 함' });
    });

    test('matchLabel matches Figure-Space (U+2007) variant', () => {
      const input = `허용${FIGURE_SPACE}안${FIGURE_SPACE}함`;
      const result = matchLabel(input, 'dismiss');
      expect(result).toEqual({ locale: 'ko', label: '허용 안 함' });
    });

    test('matchLabel collapses Word-Joiner (U+2060) inside the label', () => {
      const input = `허용${WORD_JOINER}안${WORD_JOINER}함`;
      const result = matchLabel(input, 'dismiss');
      expect(result).toEqual({ locale: 'ko', label: '허용 안 함' });
    });

    test('matchLabel collapses runs of mixed ASCII whitespace', () => {
      const result = matchLabel('  Allow   While  Using  App  ', 'accept');
      expect(result).toEqual({ locale: 'en', label: 'Allow While Using App' });
    });

    test('matchLabel matches NBSP-padded en label', () => {
      const input = `Allow${NBSP}While${NBSP}Using${NBSP}App`;
      const result = matchLabel(input, 'accept');
      expect(result).toEqual({ locale: 'en', label: 'Allow While Using App' });
    });

    test('normalizeLabel collapses NBSP runs and lowercases', () => {
      const input = `Allow${NBSP}${NBSP}While${NBSP}Using${NBSP}App`;
      expect(normalizeLabel(input)).toBe('allow while using app');
    });

    test('normalizeLabel applies NFC normalization', () => {
      // Korean syllable "한" decomposed to its jamo: U+1112 U+1161 U+11AB.
      const decomposed = '한';
      expect(decomposed.normalize('NFC')).toBe('한');
      expect(normalizeLabel(decomposed)).toBe('한');
    });
  });

  describe('registerExtraLabels (#639 Problem 4c extension seam)', () => {
    test('extends the corpus and participates in matchLabel', () => {
      const customLabel = '\uB3D9\uC758\uD558\uACE0 \uACC4\uC18D\uD558\uAE30';
      expect(matchLabel(customLabel, 'accept')).toBeNull();
      registerExtraLabels('accept', 'ko', [customLabel]);
      expect(matchLabel(customLabel, 'accept')).toEqual({
        locale: 'ko',
        label: customLabel,
      });
    });

    test('is idempotent — duplicate registrations are silent no-ops', () => {
      const before = ALL_LABELS.dismiss.ko.length;
      registerExtraLabels('dismiss', 'ko', ['\uCDE8\uC18C']); // 취소
      expect(ALL_LABELS.dismiss.ko.length).toBe(before);
    });

    test('flattenLabels surfaces the extension', () => {
      const probe = 'CustomBannerAcceptEN_v2';
      registerExtraLabels('accept', 'en', [probe]);
      expect(flattenLabels('accept')).toContain(probe);
    });
  });
});
