/**
 * #798 PR1 — redaction policy (default-v1).
 */

import {
  redactText,
  redactEnvMap,
  redactObject,
  REDACTION_POLICY_VERSION,
} from '../../src/observability/redaction';

describe('redactText (default-v1)', () => {
  it('scrubs bearer tokens', () => {
    const input = 'Auth: Bearer ya29.AhEsLghF-EX_token-1234567';
    const { text, applied } = redactText(input, 'logs');
    expect(text).toBe('Auth: Bearer [REDACTED]');
    expect(applied).toContain('logs.bearer');
  });

  it('scrubs Authorization headers without a bearer prefix', () => {
    const { text, applied } = redactText('Authorization: secret_value', 'logs');
    expect(text).toBe('Authorization: [REDACTED]');
    expect(applied).toContain('logs.authorization_header');
  });

  it('scrubs JWTs (eyJ. prefix)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiZm9vIn0.signaturesigsig';
    const { text, applied } = redactText(`session=${jwt}`, 'logs');
    expect(text).not.toContain(jwt);
    expect(text).toContain('[REDACTED_JWT]');
    expect(applied).toContain('logs.jwt');
  });

  it('scrubs AWS access keys and GitHub PATs', () => {
    const { text, applied } = redactText(
      'AKIAIOSFODNN7EXAMPLE then ghp_abcdefghijklmnopqrstuvwxyz',
      'logs',
    );
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(applied).toContain('logs.aws_access_key');
    expect(applied).toContain('logs.github_token');
  });

  it('returns identical text when nothing matches', () => {
    const { text, applied } = redactText('hello world', 'logs');
    expect(text).toBe('hello world');
    expect(applied).toEqual([]);
  });

  it('emits each applied tag at most once even when multiple matches scrubbed', () => {
    const { applied } = redactText('Bearer x Bearer y Bearer z', 'logs');
    expect(applied.filter((t) => t === 'logs.bearer')).toHaveLength(1);
  });
});

describe('redactEnvMap', () => {
  it('redacts whole values for sensitive env keys', () => {
    const result = redactEnvMap({
      PATH: '/usr/local/bin',
      AUTH_TOKEN: 'abc123',
      API_KEY: 'def456',
      MY_PASSWORD: 'xyz',
    });
    expect(result.applied).toEqual(expect.arrayContaining(['env.AUTH_TOKEN', 'env.API_KEY', 'env.MY_PASSWORD']));
    const parsed = JSON.parse(result.text);
    expect(parsed.PATH).toBe('/usr/local/bin');
    expect(parsed.AUTH_TOKEN).toBe('[REDACTED]');
    expect(parsed.API_KEY).toBe('[REDACTED]');
    expect(parsed.MY_PASSWORD).toBe('[REDACTED]');
  });

  it('still scrubs token-shaped values inside non-sensitive keys', () => {
    const result = redactEnvMap({
      MOTD: 'Welcome! Bearer abc.def.ghi',
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.MOTD).toContain('Bearer [REDACTED]');
    expect(result.applied.some((t) => t.includes('bearer'))).toBe(true);
  });
});

describe('redactObject', () => {
  it('walks nested structures and scrubs string leaves', () => {
    const input = {
      meta: { region: 'us-east-1', authToken: 'ya29.secret' },
      events: [
        { msg: 'OK Bearer abc' },
        { msg: 'plain text' },
      ],
    };
    const { value, applied } = redactObject(input, 'diagnose');
    expect(applied.length).toBeGreaterThan(0);
    expect((value.meta as { authToken: string }).authToken).toBe('[REDACTED]');
    expect((value.events[0] as { msg: string }).msg).toContain('Bearer [REDACTED]');
    expect((value.events[1] as { msg: string }).msg).toBe('plain text');
  });

  it('returns the value unchanged when there is nothing to scrub', () => {
    const { value, applied } = redactObject({ a: 1, b: 'hello' }, 'object');
    expect(value).toEqual({ a: 1, b: 'hello' });
    expect(applied).toEqual([]);
  });
});

describe('REDACTION_POLICY_VERSION', () => {
  it('is the documented default-v1 token', () => {
    expect(REDACTION_POLICY_VERSION).toBe('default-v1');
  });
});
