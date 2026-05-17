import {
  getNetworkInterceptorForSession,
  mapRule,
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

describe('network_intercept device scoping (Codex P1 on PR #762)', () => {
  // A single MCP session that targets two simulators must keep
  // interceptor state per device. Otherwise toggling network_intercept /
  // network_offline on device B mutates the state used for device A and
  // leaves stale JS hooks active on the sibling device.
  beforeEach(() => resetNetworkInterceptorsForTest());

  it('returns distinct interceptors for the same session id but different device ids', () => {
    const sessionId = 'session-1';
    const deviceA = getNetworkInterceptorForSession(sessionId, 'udid-device-a');
    const deviceB = getNetworkInterceptorForSession(sessionId, 'udid-device-b');

    deviceA.addRule({ urlPattern: '/a', action: 'block' });

    expect(deviceA).not.toBe(deviceB);
    expect(deviceA.listRules()).toHaveLength(1);
    expect(deviceB.listRules()).toHaveLength(0);
  });

  it('returns the same interceptor for repeated access with the same (session, device)', () => {
    const sessionId = 'session-1';
    const deviceId = 'udid-device-a';
    const first = getNetworkInterceptorForSession(sessionId, deviceId);
    const second = getNetworkInterceptorForSession(sessionId, deviceId);

    first.addRule({ urlPattern: '/x', action: 'block' });

    expect(second).toBe(first);
    expect(second.listRules()).toHaveLength(1);
  });

  it('treats omitted deviceId as a stable default scope distinct from any explicit deviceId', () => {
    const sessionId = 'session-1';
    const noDevice = getNetworkInterceptorForSession(sessionId);
    const explicit = getNetworkInterceptorForSession(sessionId, 'udid-explicit');

    noDevice.addRule({ urlPattern: '/no-device', action: 'block' });
    explicit.addRule({ urlPattern: '/explicit', action: 'block' });

    expect(noDevice).not.toBe(explicit);
    expect(noDevice.listRules()).toHaveLength(1);
    expect(explicit.listRules()).toHaveLength(1);
  });
});

describe('mapRule action validation (Codex P2 on PR #762)', () => {
  // The JSON Schema declares `enum: ['block', 'modify']` for `action`, but MCP
  // runtime schema enforcement is not guaranteed for every client. Unknown
  // values must be rejected up front rather than silently treated as "mock"
  // (the previous fallthrough behaviour), otherwise a typo turns into
  // unintended request rewriting.

  it('defaults to action: "block" when action is omitted', () => {
    const rule = mapRule({ urlPattern: '**/api/**' });
    expect(rule.action).toBe('block');
  });

  it('accepts action: "block"', () => {
    const rule = mapRule({ urlPattern: '**/api/**', action: 'block' });
    expect(rule.action).toBe('block');
  });

  it('accepts action: "modify" and constructs a mock response with defaults', () => {
    const rule = mapRule({ urlPattern: '**/api/**', action: 'modify' });
    expect(rule.action).toBe('mock');
    expect(rule.mockResponse?.status).toBe(200);
    expect(rule.mockResponse?.body).toBe('');
  });

  it('threads explicit statusCode + body into the mock response', () => {
    const rule = mapRule({
      urlPattern: '/login',
      action: 'modify',
      statusCode: 401,
      body: '{"error":"unauthorized"}',
    });
    expect(rule.action).toBe('mock');
    expect(rule.mockResponse?.status).toBe(401);
    expect(rule.mockResponse?.body).toBe('{"error":"unauthorized"}');
  });

  it('rejects a typo like "blok" instead of silently treating it as mock', () => {
    expect(() => mapRule({ urlPattern: '/a', action: 'blok' })).toThrow(
      /action must be "block" or "modify"/,
    );
  });

  it('rejects a non-string action (number, boolean, object)', () => {
    expect(() => mapRule({ urlPattern: '/a', action: 1 })).toThrow(
      /action must be "block" or "modify"/,
    );
    expect(() => mapRule({ urlPattern: '/a', action: true })).toThrow(
      /action must be "block" or "modify"/,
    );
    expect(() => mapRule({ urlPattern: '/a', action: {} })).toThrow(
      /action must be "block" or "modify"/,
    );
  });

  it('still requires urlPattern even when clear is not set', () => {
    expect(() => mapRule({})).toThrow(/urlPattern is required/);
  });
});
