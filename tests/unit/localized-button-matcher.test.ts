import {
  matchLabel,
  registerLabels,
  getCorpusSnapshot,
  normalizeText,
} from '../../src/tools/localized-button-matcher';

describe('localized-button-matcher', () => {
  describe('normalizeText', () => {
    const NBSP = ' ';
    const NNBSP = ' ';
    const FIGURE = ' ';
    const JOINER = '⁠';

    test('lowercases ASCII', () => {
      expect(normalizeText('Allow')).toBe('allow');
    });

    test('trims surrounding whitespace', () => {
      expect(normalizeText('  OK  ')).toBe('ok');
    });

    test('collapses NBSP to regular space', () => {
      expect(normalizeText(`Allow${NBSP}Once`)).toBe('allow once');
    });

    test('collapses Narrow-NBSP', () => {
      expect(normalizeText(`Allow${NNBSP}Once`)).toBe('allow once');
    });

    test('collapses Figure Space (U+2007)', () => {
      expect(normalizeText(`Allow${FIGURE}Once`)).toBe('allow once');
    });

    test('collapses Word Joiner (U+2060)', () => {
      expect(normalizeText(`Allow${JOINER}Once`)).toBe('allow once');
    });

    test('applies NFC normalization', () => {
      // Korean syllable "한" decomposed to jamo: U+1112 U+1161 U+11AB
      const decomposed = '한';
      expect(normalizeText(decomposed)).toBe('한');
    });
  });

  describe('corpus snapshot -- accept', () => {
    test('contains English accept labels', () => {
      const snap = getCorpusSnapshot('accept');
      expect(snap).toContain('allow');
      expect(snap).toContain('ok');
      expect(snap).toContain('allow while using app');
      expect(snap).toContain('continue');
    });

    test('contains Korean accept labels', () => {
      const snap = getCorpusSnapshot('accept');
      expect(snap).toContain('허용');   // 허용
      expect(snap).toContain('확인');   // 확인
    });

    test('contains Japanese accept labels', () => {
      const snap = getCorpusSnapshot('accept');
      expect(snap).toContain('許可');   // 許可
    });

    test('contains Chinese accept labels', () => {
      const snap = getCorpusSnapshot('accept');
      expect(snap).toContain('允许');   // 允许
    });
  });

  describe('corpus snapshot -- dismiss', () => {
    test('contains English dismiss labels', () => {
      const snap = getCorpusSnapshot('dismiss');
      expect(snap).toContain("don't allow");
      expect(snap).toContain('cancel');
    });

    test('contains Korean dismiss labels', () => {
      const snap = getCorpusSnapshot('dismiss');
      expect(snap).toContain('허용 안 함');  // 허용 안 함
    });
  });

  describe('corpus snapshot -- accept-once', () => {
    test('contains English accept-once label', () => {
      const snap = getCorpusSnapshot('accept-once');
      expect(snap).toContain('allow once');
    });

    test('contains Korean accept-once label', () => {
      const snap = getCorpusSnapshot('accept-once');
      expect(snap).toContain('한 번 허용');  // 한 번 허용
    });
  });

  describe('corpus snapshot -- paste-allow', () => {
    test('contains English paste label', () => {
      const snap = getCorpusSnapshot('paste-allow');
      expect(snap).toContain('allow paste');
    });

    test('contains Korean paste label', () => {
      const snap = getCorpusSnapshot('paste-allow');
      expect(snap).toContain('붙여넣기 허용');  // 붙여넣기 허용
    });

    test('contains Japanese paste label', () => {
      const snap = getCorpusSnapshot('paste-allow');
      expect(snap).toContain('貼り付けを許可');  // 貼り付けを許可
    });

    test('contains Chinese paste label', () => {
      const snap = getCorpusSnapshot('paste-allow');
      expect(snap).toContain('允许粘贴');  // 允许粘贴
    });
  });

  describe('matchLabel -- basic cases', () => {
    test('returns "accept" for "Allow"', () => {
      expect(matchLabel('Allow')).toBe('accept');
    });

    test('returns "accept" for "OK"', () => {
      expect(matchLabel('OK')).toBe('accept');
    });

    test('returns "dismiss" for "Cancel"', () => {
      expect(matchLabel('Cancel')).toBe('dismiss');
    });

    test('returns "dismiss" for Korean deny phrase', () => {
      expect(matchLabel('허용 안 함')).toBe('dismiss');  // 허용 안 함
    });

    test('returns "accept-once" for "Allow Once"', () => {
      expect(matchLabel('Allow Once')).toBe('accept-once');
    });

    test('returns "paste-allow" for "Allow Paste"', () => {
      expect(matchLabel('Allow Paste')).toBe('paste-allow');
    });

    test('returns "paste-allow" for Korean paste phrase', () => {
      expect(matchLabel('붙여넣기 허용')).toBe('paste-allow');  // 붙여넣기 허용
    });

    test('returns null for unknown label', () => {
      expect(matchLabel('Frob the Widget')).toBeNull();
    });

    test('is case-insensitive', () => {
      expect(matchLabel('allow')).toBe('accept');
      expect(matchLabel('CANCEL')).toBe('dismiss');
    });

    test('matches Accept-Once with NBSP whitespace variant', () => {
      const NBSP = ' ';
      expect(matchLabel(`Allow${NBSP}Once`)).toBe('accept-once');
    });
  });

  describe('registerLabels -- extension seam', () => {
    test('newly registered label is matched after registration', () => {
      registerLabels('accept', ['Yep', 'Grant Access']);
      expect(matchLabel('Yep')).toBe('accept');
      expect(matchLabel('Grant Access')).toBe('accept');
    });

    test('registered label for dismiss is matched', () => {
      registerLabels('dismiss', ['Nope']);
      expect(matchLabel('Nope')).toBe('dismiss');
    });

    test('registered paste-allow label is matched', () => {
      registerLabels('paste-allow', ['貼り付け許可ください']);
      expect(matchLabel('貼り付け許可ください')).toBe('paste-allow');
    });

    test('registered labels appear in corpus snapshot', () => {
      registerLabels('accept', ['承認']);  // 承認
      const snap = getCorpusSnapshot('accept');
      expect(snap).toContain('承認');
    });

    test('registration is case-normalised -- can match mixed case input', () => {
      registerLabels('accept', ['SpecialGrant']);
      expect(matchLabel('specialgrant')).toBe('accept');
      expect(matchLabel('SPECIALGRANT')).toBe('accept');
    });
  });

  // Codex P1 regression on PR #684 — substring matching means the negated
  // paste label CONTAINS the affirmative paste-allow substring, so the
  // bucket evaluation order has to put `dismiss` ahead of `paste-allow`
  // or `pollForPermissionDialog` would tap the deny button.
  describe('matchLabel -- negated paste labels classify as dismiss (codex P1 #684)', () => {
    test("English 'Don't Allow Paste' is dismiss, not paste-allow", () => {
      expect(matchLabel("Don't Allow Paste")).toBe('dismiss');
    });

    test('Korean 붙여넣기 허용 안 함 is dismiss, not paste-allow', () => {
      expect(matchLabel('붙여넣기 허용 안 함')).toBe('dismiss');
    });

    test('Simplified Chinese 不允许粘贴 is dismiss, not paste-allow', () => {
      expect(matchLabel('不允许粘贴')).toBe('dismiss');
    });

    test('Japanese 貼り付けを許可しない is dismiss, not paste-allow', () => {
      expect(matchLabel('貼り付けを許可しない')).toBe('dismiss');
    });

    test('affirmative paste labels still classify as paste-allow', () => {
      expect(matchLabel('Allow Paste')).toBe('paste-allow');
      expect(matchLabel('붙여넣기 허용')).toBe('paste-allow');
      expect(matchLabel('允许粘贴')).toBe('paste-allow');
      expect(matchLabel('貼り付けを許可')).toBe('paste-allow');
    });
  });
});
