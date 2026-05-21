/**
 * Unit tests for PR26 — JWT-aware auth validation.
 */

import { decodeJwtPayload, inspectAuthJwts } from '../../src/auth/jwt-inspect';
import type { AuthProfile } from '../../src/auth/manager';

function buildJwt(payload: Record<string, unknown>): string {
  const b64u = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(payload)}.sig`;
}

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const token = buildJwt({ sub: 'user-1', exp: 1700000000 });
    const out = decodeJwtPayload(token);
    expect(out).toMatchObject({ sub: 'user-1', exp: 1700000000 });
  });

  it('returns null for non-JWT strings', () => {
    expect(decodeJwtPayload('plain string')).toBeNull();
    expect(decodeJwtPayload('one.two')).toBeNull();
  });
});

describe('inspectAuthJwts', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 60;

  function profile(over: Partial<AuthProfile> = {}): AuthProfile {
    return {
      site: 'example.com',
      savedAt: new Date().toISOString(),
      currentUrl: 'https://example.com',
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      ...over,
    };
  }

  it('finds JWTs across cookies / localStorage / sessionStorage', () => {
    const t1 = buildJwt({ exp: future });
    const t2 = buildJwt({ exp: past });
    const report = inspectAuthJwts(
      profile({
        cookies: [{
          name: 'session', value: t1, domain: 'example.com', path: '/',
          expires: 0, httpOnly: false, secure: true, sameSite: 'Lax',
        }],
        localStorage: { idToken: t2, junk: 'not a jwt' },
      }),
    );
    expect(report.totalJwts).toBe(2);
    expect(report.expiredCount).toBe(1);
    expect(report.expiringCount).toBe(0);
    expect(report.isExpired).toBe(true);
    expect(report.earliestExpiry).toBe(past);
  });

  it('flags expiring tokens within the configurable window', () => {
    const soon = Math.floor(Date.now() / 1000) + 60; // 60 s away
    const report = inspectAuthJwts(
      profile({ localStorage: { soon: buildJwt({ exp: soon }) } }),
      { expiringWindowSec: 120 },
    );
    expect(report.isExpiring).toBe(true);
    expect(report.expiringCount).toBe(1);
  });

  it('returns 0 totals on a JWT-free profile', () => {
    const report = inspectAuthJwts(profile({ localStorage: { x: 'plain' } }));
    expect(report.totalJwts).toBe(0);
    expect(report.earliestExpiry).toBe(Infinity);
  });
});
