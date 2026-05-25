/**
 * Best-effort JWT inspection helpers for saved auth profiles.
 *
 * PR26 adds a JWT-aware view on top of `AuthManager.checkExpiry`: the
 * original signal (cookie `expires`) misses the case where the actual
 * auth lifetime is gated by a Bearer token stored in `localStorage`
 * or a session cookie value, which is the norm for SPA apps.
 *
 * We DO NOT verify the JWT signature — that requires the issuer's
 * public key. We just decode the payload to read `exp` so callers can
 * know whether a saved profile is still inside its server-side TTL.
 */

import type { AuthProfile } from './manager';
import type { Cookie } from '../types/browser-backend';

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export interface InspectedJwt {
  source: 'cookie' | 'localStorage' | 'sessionStorage';
  /** Identifier within source: cookie name / storage key. */
  key: string;
  /** Decoded payload (subset — `exp`, `iat`, `nbf`, plus any other claims). */
  payload: Record<string, unknown>;
  /** Unix seconds. Undefined when payload had no `exp`. */
  exp?: number;
}

export interface AuthValidationReport {
  totalJwts: number;
  expiredCount: number;
  expiringCount: number;
  /** Earliest `exp` across all inspected JWTs (unix seconds). Infinity when none. */
  earliestExpiry: number;
  isExpired: boolean;
  isExpiring: boolean;
  jwts: InspectedJwt[];
}

/** Base64url → utf-8 string. Returns null when not parseable. */
function decodeBase64Url(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/** Return the decoded payload object if `token` looks like a JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const json = decodeBase64Url(parts[1]);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function scanString(
  source: InspectedJwt['source'],
  key: string,
  value: string,
  out: InspectedJwt[],
): void {
  const match = value.match(JWT_RE);
  if (!match) return;
  const payload = decodeJwtPayload(match[0]);
  if (!payload) return;
  const exp = typeof payload.exp === 'number' ? (payload.exp as number) : undefined;
  out.push({ source, key, payload, exp });
}

/**
 * Walk every cookie + localStorage + sessionStorage value, decode any
 * JWT-shaped strings, and return per-token expiry info plus aggregate
 * counts.
 */
export function inspectAuthJwts(
  profile: AuthProfile,
  options?: { expiringWindowSec?: number },
): AuthValidationReport {
  const expiringWindow = options?.expiringWindowSec ?? 300;
  const jwts: InspectedJwt[] = [];

  for (const cookie of profile.cookies as Cookie[]) {
    if (cookie.value && typeof cookie.value === 'string') {
      scanString('cookie', cookie.name, cookie.value, jwts);
    }
  }
  for (const [key, value] of Object.entries(profile.localStorage ?? {})) {
    if (typeof value === 'string') scanString('localStorage', key, value, jwts);
  }
  for (const [key, value] of Object.entries(profile.sessionStorage ?? {})) {
    if (typeof value === 'string') scanString('sessionStorage', key, value, jwts);
  }

  const now = Date.now() / 1000;
  const withExp = jwts.filter((j) => typeof j.exp === 'number');
  const expired = withExp.filter((j) => (j.exp as number) < now);
  const expiring = withExp.filter(
    (j) => (j.exp as number) >= now && (j.exp as number) - now < expiringWindow,
  );

  return {
    totalJwts: jwts.length,
    expiredCount: expired.length,
    expiringCount: expiring.length,
    earliestExpiry: withExp.reduce((min, j) => Math.min(min, j.exp as number), Infinity),
    isExpired: expired.length > 0,
    isExpiring: expiring.length > 0,
    jwts,
  };
}
