import {
  assertPasteApplied,
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
