import { navigateSemantically } from '../../src/tools/semantic-navigation';
import { waitForSettle } from '../../src/tools/settle-policy';

jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd, _args, cb) => cb(null, '', '')),
}));
jest.mock('../../src/tools/app-state-snapshot', () => ({
  collectAppSessionState: jest.fn(async () => ({ schemaVersion: '1' })),
}));
jest.mock('../../src/tools/settle-policy', () => ({
  waitForSettle: jest.fn(async () => ({ met: false, polls: 1, elapsedMs: 1, stableForMs: 0, matchingCount: 0, lastObserved: [], errors: [] })),
}));
jest.mock('../../src/mcp-server', () => ({ getWebKitClient: jest.fn(() => null) }));
jest.mock('../../src/native', () => ({
  getAccessibilityBridge: jest.fn(() => ({ query: jest.fn(), press: jest.fn() })),
}));
jest.mock('../../src/tools/native-input-utils', () => ({
  getInputBackend: jest.fn(async () => ({ kind: 'simhid', tap: jest.fn() })),
}));
const evaluate = jest.fn(async () => ({ valueAsString: 'opensafari_route:ok' }));
jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({ isConnected: () => true, evaluate }),
}));

describe('semantic navigation combined route+AX postconditions', () => {
  jest.setTimeout(10000);
  beforeEach(() => {
    jest.clearAllMocks();
    evaluate.mockResolvedValue({ valueAsString: 'opensafari_route:ok' });
    (waitForSettle as jest.Mock).mockResolvedValue({ met: false, polls: 1, elapsedMs: 1, stableForMs: 0, matchingCount: 0, lastObserved: [], errors: [] });
  });

  it('honors caller timeout for slower route-only verification', async () => {
    let calls = 0;
    evaluate.mockImplementation(async () => ({
      valueAsString: ++calls >= 10 ? 'opensafari_route:ok' : 'opensafari_route:mismatch:/loading',
    }));
    const result = await navigateSemantically({
      deviceId: 'D1',
      postcondition: { route: '/settings', timeoutMs: 1800 },
      collectState: false,
    });
    expect(result.strategy).toBe('already_on_target');
    expect(calls).toBeGreaterThanOrEqual(10);
  });

  it('does not pass from route-only evidence when AX postcondition is also requested', async () => {
    const result = await navigateSemantically({
      deviceId: 'D1',
      url: 'myapp://settings',
      postcondition: { route: '/settings', identifier: 'settings-title', timeoutMs: 1 },
      collectState: false,
    });
    expect(result.strategy).toBe('failed');
    expect(result.attempts.some((a) => a.strategy === 'flutter_route' && a.ok)).toBe(false);
  });
});
