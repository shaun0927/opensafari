import { resolveAuditProxyPort } from '../../src/cli/audit-port';

describe('resolveAuditProxyPort', () => {
  const defaultPort = 9322;

  it('uses the explicit --port value before OPENSAFARI_PROXY_PORT', () => {
    expect(resolveAuditProxyPort(9500, '9600')).toBe(9500);
  });

  it('uses OPENSAFARI_PROXY_PORT when --port is absent', () => {
    expect(resolveAuditProxyPort(undefined, '9600')).toBe(9600);
  });

  it('falls back to the default port when no port is configured', () => {
    expect(resolveAuditProxyPort(undefined, undefined)).toBe(defaultPort);
  });

  it('rejects an invalid explicit --port value', () => {
    expect(() => resolveAuditProxyPort(Number.NaN, '9600')).toThrow('Invalid port value: NaN');
  });

  it('rejects an invalid OPENSAFARI_PROXY_PORT value instead of silently falling back', () => {
    expect(() => resolveAuditProxyPort(undefined, 'not-a-port')).toThrow('Invalid port value: not-a-port');
  });

  it('rejects partial numeric strings and out-of-range ports', () => {
    expect(() => resolveAuditProxyPort(undefined, '9322abc')).toThrow('Invalid port value: 9322abc');
    expect(() => resolveAuditProxyPort(0, undefined)).toThrow('Invalid port value: 0');
    expect(() => resolveAuditProxyPort(65536, undefined)).toThrow('Invalid port value: 65536');
  });
});
