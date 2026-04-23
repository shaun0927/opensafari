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
    // Short inputs (≤ 24 chars) are echoed verbatim — no truncation sentinel.
    expect(hint?.expected).toBe('qa.signup@example.com');
    expect(hint?.actual).toBe('ㄴ뎁ㅁ.냐후ㅕㅔ@ㄷㅌ므ㅔㅣㄷ.채ㅡ');
    expect(hint?.truncated).toBe(false);
    expect(hint?.suggestedBackend).toBe('pasteboard');
    expect(hint?.detectedLayout).toBe(koEntry);
    expect(hint?.layoutSource).toBe('apple_keyboards_first_entry');
  });

  test('returns a hint for a Japanese Kana layout (non-Latin)', () => {
    const jpEntry = 'ja_JP@sw=Kana;hw=Automatic';
    const hint = mismatchHint('hello', 'こんにちは', jpEntry);
    expect(hint?.code).toBe('TEXT_INPUT_LAYOUT_MISMATCH');
    expect(hint?.suggestedBackend).toBe('pasteboard');
    expect(hint?.layoutSource).toBe('apple_keyboards_first_entry');
  });

  test('truncates long expected/actual values so hint payload never leaks full user text', () => {
    const koEntry = 'ko_KR@sw=Korean;hw=Automatic';
    const longExpected = 'pfx-0123456789012345678901-SECRET_TAIL_THAT_MUST_NOT_LEAK';
    const longActual = 'ㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁ-TAIL';
    const hint = mismatchHint(longExpected, longActual, koEntry);
    expect(hint).not.toBeNull();
    // Both sides are capped at 24 code units and suffixed with `…`.
    expect(hint?.expected.length).toBeLessThanOrEqual(25);
    expect(hint?.actual.length).toBeLessThanOrEqual(25);
    expect(hint?.expected.endsWith('…')).toBe(true);
    expect(hint?.actual.endsWith('…')).toBe(true);
    expect(hint?.truncated).toBe(true);
    // Full originals must NOT be reachable through the hint payload — the
    // tail beyond the echo window is dropped.
    expect(hint?.expected).not.toBe(longExpected);
    expect(hint?.actual).not.toBe(longActual);
    expect(JSON.stringify(hint)).not.toContain('SECRET_TAIL_THAT_MUST_NOT_LEAK');
    expect(JSON.stringify(hint)).not.toContain('-TAIL');
  });

  test('hint payload is JSON-serialisable (transports cleanly through MCP)', () => {
    const hint = mismatchHint('qa', 'ㅂㅁ', 'ko_KR@sw=Korean;hw=Automatic');
    expect(() => JSON.parse(JSON.stringify(hint))).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(hint));
    expect(parsed.code).toBe('TEXT_INPUT_LAYOUT_MISMATCH');
    expect(parsed.suggestedBackend).toBe('pasteboard');
    expect(parsed.layoutSource).toBe('apple_keyboards_first_entry');
    expect(parsed.truncated).toBe(false);
  });
});
