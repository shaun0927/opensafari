/**
 * #797 PR1 — catalog expansion + respondWithStructuredError helper.
 *
 * Verifies the new ErrorCode entries are reachable through the catalog
 * and that the helper produces the canonical 5-key envelope plus any
 * tool-specific extras the caller supplies.
 */

import {
  ErrorCode,
  ERROR_CATALOG,
  StructuredErrorException,
  respondWithStructuredError,
} from '../../src/errors';

describe('error catalog expansion (#797 PR1)', () => {
  const NEW_CODES: ErrorCode[] = [
    ErrorCode.INVALID_INPUT,
    ErrorCode.MISSING_REQUIRED_PARAM,
    ErrorCode.INVALID_URL,
    ErrorCode.DEVICE_NOT_BOOTED,
    ErrorCode.SESSION_NOT_FOUND,
    ErrorCode.BACKEND_NOT_CONNECTED,
    ErrorCode.FLUTTER_VM_NOT_CONNECTED,
    ErrorCode.FLUTTER_EVAL_FAILED,
    ErrorCode.OVERLAY_DISMISS_FAILED,
    ErrorCode.KEYBOARD_DISMISS_FAILED,
    ErrorCode.ALERT_NO_EFFECT,
    ErrorCode.PERMISSION_RESET_DENIED,
    ErrorCode.POP_UNTIL_EXHAUSTED,
    ErrorCode.POP_UNTIL_NO_FALLBACK_AVAILABLE,
    ErrorCode.MISSING_POSTCONDITION,
  ];

  it.each(NEW_CODES)('catalog entry exists for %s', (code) => {
    const entry = ERROR_CATALOG[code];
    expect(entry).toBeDefined();
    expect(entry.code).toBe(code);
    expect(typeof entry.recoverable).toBe('boolean');
    expect(typeof entry.suggestion).toBe('string');
    expect(entry.suggestion.length).toBeGreaterThan(0);
  });

  it('fromCode pulls metadata for newly-added codes', () => {
    const err = StructuredErrorException.fromCode(
      ErrorCode.DEVICE_NOT_BOOTED,
      'no booted simulator',
    );
    expect(err.code).toBe(ErrorCode.DEVICE_NOT_BOOTED);
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toMatch(/device_boot|deviceId/);
  });

  it('PERMISSION_RESET_DENIED is marked non-recoverable (host TCC boundary)', () => {
    expect(ERROR_CATALOG[ErrorCode.PERMISSION_RESET_DENIED].recoverable).toBe(false);
  });

  it('POP_UNTIL_NO_FALLBACK_AVAILABLE is marked non-recoverable', () => {
    expect(ERROR_CATALOG[ErrorCode.POP_UNTIL_NO_FALLBACK_AVAILABLE].recoverable).toBe(false);
  });
});

describe('respondWithStructuredError helper (#797 PR1)', () => {
  it('produces the canonical envelope shape', () => {
    const response = respondWithStructuredError(
      ErrorCode.INVALID_INPUT,
      'until must be one of first/route/count',
    );
    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error).toBe(ErrorCode.INVALID_INPUT);
    expect(payload.message).toBe('until must be one of first/route/count');
    expect(payload.recoverable).toBe(true);
    expect(typeof payload.suggestion).toBe('string');
  });

  it('preserves tool-specific extras alongside the canonical fields', () => {
    const response = respondWithStructuredError(
      ErrorCode.FLUTTER_VM_NOT_CONNECTED,
      'Call flutter_connect first.',
      { deviceId: 'DEV-1', target: { until: 'first' } },
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      error: ErrorCode.FLUTTER_VM_NOT_CONNECTED,
      message: 'Call flutter_connect first.',
      deviceId: 'DEV-1',
      target: { until: 'first' },
    });
    expect(payload.recoverable).toBe(true);
  });

  it('extras cannot accidentally clobber the canonical error/recoverable/suggestion keys', () => {
    const response = respondWithStructuredError(
      ErrorCode.MISSING_REQUIRED_PARAM,
      'name is required',
      {
        error: 'AD_HOC_ERROR',
        message: 'wrong message',
        recoverable: false,
        suggestion: 'wrong suggestion',
        context: 'app_pop_until',
      },
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      error: ErrorCode.MISSING_REQUIRED_PARAM,
      message: 'name is required',
      recoverable: true,
      suggestion: ERROR_CATALOG[ErrorCode.MISSING_REQUIRED_PARAM].suggestion,
      context: 'app_pop_until',
    });
  });
});
