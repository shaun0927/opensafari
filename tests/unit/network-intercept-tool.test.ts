import {
  getNetworkInterceptorForSession,
  removeNetworkInterceptorForSession,
  resetNetworkInterceptorsForTest,
} from '../../src/tools/network-intercept';

describe('network_intercept session scoping', () => {
  beforeEach(() => resetNetworkInterceptorsForTest());

  it('keeps rule state isolated by MCP session id', () => {
    const a = getNetworkInterceptorForSession('session-a');
    const b = getNetworkInterceptorForSession('session-b');

    a.addRule({ urlPattern: '**/api/**', action: 'block' });

    expect(a.listRules()).toHaveLength(1);
    expect(b.listRules()).toHaveLength(0);
  });

  it('returns the same interceptor for repeated access to one session', () => {
    const a1 = getNetworkInterceptorForSession('session-a');
    const a2 = getNetworkInterceptorForSession('session-a');
    a1.addRule({
      urlPattern: '/login',
      action: 'mock',
      mockResponse: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' },
    });

    expect(a2.listRules()).toHaveLength(1);
    expect(a2.findMatchingRule('https://example.com/login')?.action).toBe('mock');
  });

  it('evicts only the selected MCP session cache on session deletion', () => {
    const a1 = getNetworkInterceptorForSession('session-a');
    const b = getNetworkInterceptorForSession('session-b');

    a1.addRule({ urlPattern: '/a', action: 'block' });
    b.addRule({ urlPattern: '/b', action: 'block' });

    expect(removeNetworkInterceptorForSession('session-a')).toBe(1);

    const a2 = getNetworkInterceptorForSession('session-a');
    expect(a2).not.toBe(a1);
    expect(a2.listRules()).toHaveLength(0);
    expect(b.listRules()).toHaveLength(1);
  });

  it('reports no eviction for unknown or empty session ids', () => {
    getNetworkInterceptorForSession('session-a').addRule({ urlPattern: '/a', action: 'block' });

    expect(removeNetworkInterceptorForSession('missing')).toBe(0);
    expect(removeNetworkInterceptorForSession('')).toBe(0);
    expect(getNetworkInterceptorForSession('session-a').listRules()).toHaveLength(1);
  });

  it('clear/disable restores and clears only the selected session', async () => {
    const a = getNetworkInterceptorForSession('session-a');
    const b = getNetworkInterceptorForSession('session-b');
    const client = { evaluate: jest.fn().mockResolvedValue(undefined) };

    a.addRule({ urlPattern: '/a', action: 'block' });
    b.addRule({ urlPattern: '/b', action: 'block' });
    await a.disable(client);

    expect(a.listRules()).toHaveLength(0);
    expect(b.listRules()).toHaveLength(1);
    expect(client.evaluate.mock.calls[0][0]).toContain('__osOriginalXHROpen');
  });
});
