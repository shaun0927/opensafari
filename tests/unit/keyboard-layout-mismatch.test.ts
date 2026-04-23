import { mismatchHint, isLatinSoftwareLayout } from '../../src/tools/keyboard-layout';

describe('mismatchHint (issue #639 Problem 1 — fail-loud on non-Latin layout)', () => {
  test('returns null when detectedLayout is null (probe failed)', () => {
    expect(mismatchHint('qa@example.com', 'whatever', null)).toBeNull();
  });

  test('returns null for a Latin (QWERTY) software layout', () => {
    const usEntry = 'en_US@hw=Automatic;sw=QWERTY';
    expect(isLatinSoftwareLayout(usEntry)).toBe(true);
    expect(mismatchHint('qa@example.com', 'qa@exmple.com', usEntry)).toBeNull();
  });

  test('returns a structured TEXT_INPUT_LAYOUT_MISMATCH for a Korean 2-Set layout', () => {
    // Real-world AppleKeyboards entry shape; sw=Korean is the load-bearing
    // signal that the simulator's active software layout is non-Latin.
    const koEntry = 'ko_KR@sw=Korean;hw=Automatic';
    expect(isLatinSoftwareLayout(koEntry)).toBe(false);
    const hint = mismatchHint(
      'qa.signup@example.com',
      'ㄴ뎁ㅁ.냐후ㅕㅔ@ㄷㅌ므ㅔㅣㄷ.채ㅡ',
      koEntry,
    );
    expect(hint).not.toBeNull();
    expect(hint?.code).toBe('TEXT_INPUT_LAYOUT_MISMATCH');
    expect(hint?.expected).toBe('qa.signup@example.com');
    expect(hint?.actual).toBe('ㄴ뎁ㅁ.냐후ㅕㅔ@ㄷㅌ므ㅔㅣㄷ.채ㅡ');
    expect(hint?.suggestedBackend).toBe('pasteboard');
    expect(hint?.detectedLayout).toBe(koEntry);
  });

  test('returns a hint for a Japanese Kana layout (non-Latin)', () => {
    const jpEntry = 'ja_JP@sw=Kana;hw=Automatic';
    const hint = mismatchHint('hello', 'こんにちは', jpEntry);
    expect(hint?.code).toBe('TEXT_INPUT_LAYOUT_MISMATCH');
    expect(hint?.suggestedBackend).toBe('pasteboard');
  });

  test('hint payload is JSON-serialisable (transports cleanly through MCP)', () => {
    const hint = mismatchHint('qa', 'ㅂㅁ', 'ko_KR@sw=Korean;hw=Automatic');
    expect(() => JSON.parse(JSON.stringify(hint))).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(hint));
    expect(parsed.code).toBe('TEXT_INPUT_LAYOUT_MISMATCH');
    expect(parsed.suggestedBackend).toBe('pasteboard');
  });
});
