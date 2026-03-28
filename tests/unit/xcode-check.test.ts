import type { XcodeCheckResult } from '../../src/simulator/xcode-check';
import { checkXcodeInstallation } from '../../src/simulator/xcode-check';

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

describe('checkXcodeInstallation behavioral', () => {
  it('sets devicePortReachable to false by default (no network probe on non-darwin)', async () => {
    if (process.platform !== 'darwin') {
      const result = await checkXcodeInstallation();
      expect(result.devicePortReachable).toBe(false);
      expect(result.devicePort).toBeUndefined();
    } else {
      const result = await checkXcodeInstallation();
      expect(typeof result.devicePortReachable).toBe('boolean');
    }
  }, 15000);

  it('does not probe device port when proxy is not reachable', async () => {
    if (process.platform !== 'darwin') {
      const result = await checkXcodeInstallation();
      expect(result.proxyReachable).toBe(false);
      expect(result.devicePortReachable).toBe(false);
    } else {
      const result = await checkXcodeInstallation();
      if (!result.proxyReachable) {
        expect(result.devicePortReachable).toBe(false);
        expect(result.devicePort).toBeUndefined();
      }
    }
  }, 15000);
});
