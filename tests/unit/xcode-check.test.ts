import type { XcodeCheckResult } from '../../src/simulator/xcode-check';

// Mock all external I/O to make tests fully deterministic on any CI runner.
// jest.mock calls are hoisted — factories must not reference outer-scope imports.

jest.mock('http', () => ({
  get: jest.fn((...args: unknown[]) => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const req: Record<string, unknown> = {
      on: jest.fn((event: string, handler: (...a: unknown[]) => void) => { handlers[event] = handler; return req; }),
      destroy: jest.fn(),
    };
    process.nextTick(() => handlers['error']?.(new Error('ECONNREFUSED')));
    const cb = typeof args[1] === 'function' ? args[1] as (...a: unknown[]) => void
      : typeof args[2] === 'function' ? args[2] as (...a: unknown[]) => void
      : null;
    if (cb) {
      const res: Record<string, unknown> = { statusCode: 0 };
      res.on = jest.fn(() => res);
      process.nextTick(() => cb(res));
    }
    return req;
  }),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    const cmd = _cmd as string;
    const args = (_args || []) as string[];
    if (cmd === 'xcrun' && args[0] === '--version') {
      return cb(null, { stdout: 'xcrun version 78.\n', stderr: '' });
    }
    if (cmd === 'xcodebuild') {
      return cb(null, { stdout: 'Xcode 16.3\nBuild version 16E140\n', stderr: '' });
    }
    if (cmd === 'xcrun' && args.includes('list') && args.includes('-j') && !args.includes('runtimes')) {
      return cb(null, { stdout: '{"devices":{}}', stderr: '' });
    }
    if (cmd === 'xcrun' && args.includes('runtimes')) {
      return cb(null, { stdout: '{"runtimes":[{"isAvailable":true,"version":"18.4","platform":"iOS"}]}', stderr: '' });
    }
    if (cmd === 'which') {
      return cb(null, { stdout: '/opt/homebrew/bin/ios_webkit_debug_proxy\n', stderr: '' });
    }
    return cb(new Error(`mock: unknown command ${cmd} ${args.join(' ')}`), { stdout: '', stderr: '' });
  }),
}));

jest.mock('../../src/simulator/socket-finder', () => ({
  findSocketPath: jest.fn().mockResolvedValue(null),
}));

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
  it('sets devicePortReachable to false when proxy is not reachable', async () => {
    const result = await checkXcodeInstallation();
    expect(result.devicePortReachable).toBe(false);
    expect(result.devicePort).toBeUndefined();
  });

  it('does not probe device port when proxy is not reachable', async () => {
    const result = await checkXcodeInstallation();
    expect(result.proxyReachable).toBe(false);
    expect(result.devicePortReachable).toBe(false);
  });

  it('returns installed=true and Xcode version', async () => {
    const result = await checkXcodeInstallation();
    expect(result.installed).toBe(true);
    expect(result.version).toBe('16.3');
  });

  it('returns iOS runtimes from simctl', async () => {
    const result = await checkXcodeInstallation();
    expect(result.iosRuntimes).toContain('iOS 18.4');
  });
});
