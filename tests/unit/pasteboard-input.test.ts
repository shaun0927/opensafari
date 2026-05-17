import {
  assertPasteApplied,
  isSecureFieldDescriptor,
  type PasteNotAppliedError,
} from '../../src/tools/pasteboard-input';

describe('assertPasteApplied (issue #639 Problem 3 — readback contract)', () => {
  test('returns silently when actual === expected', () => {
    expect(() =>
      assertPasteApplied('qa@example.com', 'qa@example.com', false),
    ).not.toThrow();
  });

  test('returns silently when actual ends with expected (placeholder + paste)', () => {
    expect(() =>
      assertPasteApplied('Email: qa@example.com', 'qa@example.com', true),
    ).not.toThrow();
  });

  test('returns silently when actual contains expected (cursor mid-string)', () => {
    expect(() =>
      assertPasteApplied('foo qa@example.com bar', 'qa@example.com', false),
    ).not.toThrow();
  });

  test('returns silently when actual is undefined (bridge readback failed)', () => {
    // We cannot distinguish "paste failed" from "bridge unavailable" — must not
    // surface PASTE_NOT_APPLIED in that case.
    expect(() =>
      assertPasteApplied(undefined, 'qa@example.com', false),
    ).not.toThrow();
  });

  test('throws PASTE_NOT_APPLIED with empty actual after Cmd+V', () => {
    let caught: PasteNotAppliedError | undefined;
    try {
      assertPasteApplied('', 'qa@example.com', false);
    } catch (err) {
      caught = err as PasteNotAppliedError;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('PASTE_NOT_APPLIED');
    expect(caught?.expected).toBe('qa@example.com');
    expect(caught?.actual).toBe('');
    expect(caught?.permissionDialogObserved).toBe(false);
  });

  test('throws PASTE_NOT_APPLIED with divergent actual; preserves permissionDialogObserved=true', () => {
    let caught: PasteNotAppliedError | undefined;
    try {
      assertPasteApplied('different value', 'qa@example.com', true);
    } catch (err) {
      caught = err as PasteNotAppliedError;
    }
    expect(caught?.code).toBe('PASTE_NOT_APPLIED');
    expect(caught?.actual).toBe('different value');
    expect(caught?.permissionDialogObserved).toBe(true);
  });
});

describe('assertPasteApplied — secure-text-field skip (issue #760)', () => {
  // iOS masks AXSecureTextField AXValue with bullet characters regardless of
  // the underlying plaintext. The readback contract cannot prove what was
  // typed, so the verifier must return silently for this element class —
  // otherwise every password paste is rejected as PASTE_NOT_APPLIED.

  test('returns silently when role is AXSecureTextField (bullet-masked actual)', () => {
    expect(() =>
      assertPasteApplied('••••••••••••••••', '0ZPGw9^sxpJHx2$h', true, {
        role: 'AXSecureTextField',
      }),
    ).not.toThrow();
  });

  test('returns silently when traits include AXSecureTextField', () => {
    expect(() =>
      assertPasteApplied('••••••••••••••••', '0ZPGw9^sxpJHx2$h', true, {
        role: 'AXTextField',
        traits: ['AXSecureTextField', 'secure text field'],
      }),
    ).not.toThrow();
  });

  test('returns silently when traits include the lower-case "secure text field" alias only', () => {
    expect(() =>
      assertPasteApplied('••••••••', '12345678', false, {
        role: 'AXTextField',
        traits: ['secure text field'],
      }),
    ).not.toThrow();
  });

  test('still throws PASTE_NOT_APPLIED for non-secure fields with divergent actual', () => {
    expect(() =>
      assertPasteApplied('different', 'expected', false, {
        role: 'AXTextField',
        traits: ['text field'],
      }),
    ).toThrow('PASTE_NOT_APPLIED');
  });

  test('returns silently without descriptor (legacy callers) when actual matches', () => {
    expect(() =>
      assertPasteApplied('qa@example.com', 'qa@example.com', false),
    ).not.toThrow();
  });
});

describe('isSecureFieldDescriptor', () => {
  test('false for undefined / empty descriptor', () => {
    expect(isSecureFieldDescriptor(undefined)).toBe(false);
    expect(isSecureFieldDescriptor({})).toBe(false);
  });

  test('true when role === AXSecureTextField', () => {
    expect(isSecureFieldDescriptor({ role: 'AXSecureTextField' })).toBe(true);
  });

  test('true when traits include AXSecureTextField', () => {
    expect(
      isSecureFieldDescriptor({
        role: 'AXTextField',
        traits: ['AXSecureTextField'],
      }),
    ).toBe(true);
  });

  test('true when traits include "secure text field"', () => {
    expect(
      isSecureFieldDescriptor({
        role: 'AXTextField',
        traits: ['secure text field'],
      }),
    ).toBe(true);
  });

  test('false for ordinary text fields', () => {
    expect(
      isSecureFieldDescriptor({
        role: 'AXTextField',
        traits: ['text field'],
      }),
    ).toBe(false);
  });
});
