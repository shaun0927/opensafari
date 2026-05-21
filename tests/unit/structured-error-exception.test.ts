/**
 * Unit tests for PR20 — StructuredErrorException + toMcpErrorResponse.
 */

import {
  ErrorCode,
  StructuredErrorException,
  isStructuredErrorException,
  toMcpErrorResponse,
} from '../../src/errors';

describe('StructuredErrorException', () => {
  it('fromCode pulls recoverable + suggestion from the catalog', () => {
    const err = StructuredErrorException.fromCode(
      ErrorCode.WEBKIT_CONNECT_FAILED,
      'Could not reach localhost:9322',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ErrorCode.WEBKIT_CONNECT_FAILED);
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toMatch(/ios-webkit-debug-proxy/);
    expect(err.message).toContain('Could not reach');
  });

  it('toMcpResponse stringifies code + suggestion + recoverable', () => {
    const err = StructuredErrorException.fromCode(ErrorCode.XCODE_NOT_FOUND, 'xcrun missing');
    const response = err.toMcpResponse({ deviceId: 'DEV-1' });
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      error: ErrorCode.XCODE_NOT_FOUND,
      message: 'xcrun missing',
      recoverable: false,
      deviceId: 'DEV-1',
    });
    expect(typeof payload.suggestion).toBe('string');
  });

  it('toJSON returns plain object', () => {
    const err = StructuredErrorException.fromCode(ErrorCode.APP_NOT_INSTALLED, 'no bundle');
    const obj = err.toJSON();
    expect(obj.code).toBe(ErrorCode.APP_NOT_INSTALLED);
    expect(obj.recoverable).toBe(false);
  });
});

describe('isStructuredErrorException', () => {
  it('identifies wrapped structured errors', () => {
    const err = StructuredErrorException.fromCode(ErrorCode.SIM_BOOT_FAILED, 'oops');
    expect(isStructuredErrorException(err)).toBe(true);
  });

  it('rejects plain Errors', () => {
    expect(isStructuredErrorException(new Error('boom'))).toBe(false);
  });
});

describe('toMcpErrorResponse', () => {
  it('round-trips a StructuredErrorException', () => {
    const err = StructuredErrorException.fromCode(ErrorCode.AUTH_EXPIRED, 'token expired');
    const response = toMcpErrorResponse(err);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error).toBe(ErrorCode.AUTH_EXPIRED);
    expect(payload.recoverable).toBe(true);
  });

  it('wraps an unknown Error with the fallback code', () => {
    const response = toMcpErrorResponse(new Error('mystery'), ErrorCode.APP_STATE_UNKNOWN);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error).toBe(ErrorCode.APP_STATE_UNKNOWN);
    expect(payload.message).toBe('mystery');
    expect(payload.recoverable).toBe(true);
  });
});
