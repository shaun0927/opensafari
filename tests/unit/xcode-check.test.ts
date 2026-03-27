import type { XcodeCheckResult } from '../../src/simulator/xcode-check';

describe('XcodeCheckResult interface', () => {
  it('includes devicePortReachable and devicePort fields', () => {
    const result: XcodeCheckResult = {
      installed: true,
      simulatorAvailable: true,
      iosRuntimes: ['iOS 26.4'],
      proxyReachable: true,
      proxyPort: 9321,
      devicePortReachable: true,
      devicePort: 9322,
      issues: [],
      suggestions: [],
    };
    expect(result.devicePortReachable).toBe(true);
    expect(result.devicePort).toBe(9322);
  });

  it('defaults devicePortReachable to false when proxy is not reachable', () => {
    const result: XcodeCheckResult = {
      installed: true,
      simulatorAvailable: true,
      iosRuntimes: [],
      proxyReachable: false,
      devicePortReachable: false,
      issues: [],
      suggestions: [],
    };
    expect(result.devicePortReachable).toBe(false);
    expect(result.devicePort).toBeUndefined();
  });
});
