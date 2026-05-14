import { NetworkInterceptor, matchUrl, globToRegex } from '../../src/network-interceptor';

describe('globToRegex', () => {
  it('converts simple wildcard', () => {
    const re = globToRegex('*.js');
    expect(re.test('app.js')).toBe(true);
    expect(re.test('path/app.js')).toBe(false);
  });
  it('converts double-star wildcard', () => {
    const re = globToRegex('**/api/*');
    expect(re.test('https://example.com/api/users')).toBe(true);
    expect(re.test('https://example.com/other')).toBe(false);
  });
  it('escapes dots in domain patterns', () => {
    const re = globToRegex('*.analytics.com/**');
    expect(re.test('track.analytics.com/v1/event')).toBe(true);
    expect(re.test('trackXanalyticsXcom/v1/event')).toBe(false);
  });
  it('handles question mark', () => {
    const re = globToRegex('file?.txt');
    expect(re.test('file1.txt')).toBe(true);
    expect(re.test('file12.txt')).toBe(false);
  });
});

describe('matchUrl', () => {
  it('substring match when no wildcards', () => {
    expect(matchUrl('https://example.com/api/users', '/api/')).toBe(true);
    expect(matchUrl('https://example.com/home', '/api/')).toBe(false);
  });
  it('glob match with wildcards', () => {
    expect(matchUrl('app.js', '*.js')).toBe(true);
    expect(matchUrl('https://cdn.example.com/app.js', '**/*.js')).toBe(true);
  });
  it('matches analytics blocking pattern', () => {
    expect(matchUrl('https://track.analytics.com/v1/event', '**analytics.com/**')).toBe(true);
  });
  it('matches API mock pattern', () => {
    expect(matchUrl('https://api.example.com/v1/users', '**/v1/users')).toBe(true);
    expect(matchUrl('https://api.example.com/v2/users', '**/v1/users')).toBe(false);
  });
});

describe('NetworkInterceptor', () => {
  let interceptor: NetworkInterceptor;
  beforeEach(() => { interceptor = new NetworkInterceptor(); });

  describe('rule management', () => {
    it('adds a rule with an id', () => {
      const rule = interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      expect(rule.id).toMatch(/^rule_\d+$/);
    });
    it('lists all rules', () => {
      interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      interceptor.addRule({ urlPattern: '**/api/*', action: 'mock', mockResponse: { status: 200, headers: {}, body: '{}' } });
      expect(interceptor.listRules()).toHaveLength(2);
    });
    it('removes a rule by id', () => {
      const rule = interceptor.addRule({ urlPattern: '*.css', action: 'block' });
      expect(interceptor.removeRule(rule.id)).toBe(true);
      expect(interceptor.listRules()).toHaveLength(0);
    });
    it('returns false for non-existent rule', () => {
      expect(interceptor.removeRule('rule_999999')).toBe(false);
    });
    it('clears all rules', () => {
      interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      interceptor.clearRules();
      expect(interceptor.listRules()).toHaveLength(0);
    });
  });

  describe('findMatchingRule', () => {
    it('returns first matching rule', () => {
      interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      const mockRule = interceptor.addRule({ urlPattern: '**/api/*', action: 'mock', mockResponse: { status: 404, headers: {}, body: 'Not Found' } });
      expect(interceptor.findMatchingRule('https://example.com/api/users')?.id).toBe(mockRule.id);
    });
    it('returns undefined when no match', () => {
      interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      expect(interceptor.findMatchingRule('https://example.com/style.css')).toBeUndefined();
    });
  });

  describe('enable/disable', () => {
    const mockClient = { evaluate: jest.fn().mockResolvedValue(undefined) };
    it('sets enabled on enable', async () => {
      await interceptor.enable(mockClient);
      expect(interceptor.enabled).toBe(true);
      expect(mockClient.evaluate).toHaveBeenCalled();
    });
    it('clears state on disable', async () => {
      interceptor.addRule({ urlPattern: '*.js', action: 'block' });
      await interceptor.enable(mockClient);
      await interceptor.disable(mockClient);
      expect(interceptor.enabled).toBe(false);
      expect(interceptor.listRules()).toHaveLength(0);
    });
  });

  describe('offline mode', () => {
    const mockClient = { evaluate: jest.fn().mockResolvedValue(undefined) };
    it('enables offline and auto-enables interception', async () => {
      await interceptor.setOffline(true, mockClient);
      expect(interceptor.offline).toBe(true);
      expect(interceptor.enabled).toBe(true);
    });
    it('disables offline and restores hooks when no intercept rules remain', async () => {
      await interceptor.setOffline(true, mockClient);
      await interceptor.setOffline(false, mockClient);
      expect(interceptor.offline).toBe(false);
      expect(interceptor.enabled).toBe(false);
      expect(mockClient.evaluate.mock.calls.at(-1)?.[0]).toContain('__osOriginalXHROpen');
    });
    it('disables offline without clearing active intercept rules', async () => {
      interceptor.addRule({ urlPattern: '/api', action: 'block' });
      await interceptor.enable(mockClient);
      await interceptor.setOffline(true, mockClient);
      await interceptor.setOffline(false, mockClient);
      expect(interceptor.offline).toBe(false);
      expect(interceptor.enabled).toBe(true);
      expect(interceptor.listRules()).toHaveLength(1);
    });
  });

  describe('syncRules', () => {
    const mockClient = { evaluate: jest.fn().mockResolvedValue(undefined) };
    it('re-injects when enabled', async () => {
      await interceptor.enable(mockClient);
      mockClient.evaluate.mockClear();
      await interceptor.syncRules(mockClient);
      expect(mockClient.evaluate).toHaveBeenCalledTimes(1);
    });
    it('skips when disabled', async () => {
      mockClient.evaluate.mockClear();
      await interceptor.syncRules(mockClient);
      expect(mockClient.evaluate).not.toHaveBeenCalled();
    });
  });
});
