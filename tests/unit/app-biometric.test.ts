/**
 * Unit tests for PR5 — `app_biometric` tool + Face/Touch ID alert label coverage.
 *
 * Mocks child_process.execFile so the test never shells out to the real
 * xcrun. Verifies the four supported actions map to the right
 * `simctl ui ... biometric` invocations.
 */

import { ACCEPT_LABELS, matchLabel } from '../../src/tools/app-handle-alert-labels';

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'DEV-1' }]),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'DEV-1',
  }),
}));

import { registerAppBiometricTool } from '../../src/tools/app-biometric';

type Handler = (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_d: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as Parameters<typeof registerAppBiometricTool>[0];
  registerAppBiometricTool(server);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('app_biometric tool', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    // promisify(execFile)(...) is what the production code awaits; the
    // node `util.promisify` adapter handles a (err, value) callback. Make
    // the mock invoke its callback synchronously with no error.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, value: unknown) => void) => {
      cb(null, { stdout: '', stderr: '' });
    });
  });

  it.each([
    ['enroll', ['simctl', 'ui', 'DEV-1', 'biometric', 'enrollment', '--enroll=true']],
    ['unenroll', ['simctl', 'ui', 'DEV-1', 'biometric', 'enrollment', '--enroll=false']],
    ['match', ['simctl', 'ui', 'DEV-1', 'biometric', 'match']],
    ['nonmatch', ['simctl', 'ui', 'DEV-1', 'biometric', 'nonmatch']],
  ])('action=%s issues the correct simctl ui command', async (action, expectedArgs) => {
    const handler = captureHandler();
    const result = await handler('s', { action });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    const call = mockExecFile.mock.calls[0];
    expect(call[0]).toBe('xcrun');
    expect(call[1]).toEqual(expectedArgs);
  });

  it('rejects invalid action', async () => {
    const handler = captureHandler();
    const result = await handler('s', { action: 'identify' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('INVALID_ACTION');
  });

  it('surfaces simctl failure via BIOMETRIC_FAILED', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => {
      cb(new Error('simctl: no such device'));
    });
    const handler = captureHandler();
    const result = await handler('s', { action: 'match' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('BIOMETRIC_FAILED');
    expect(body.message).toContain('simctl');
  });
});

describe('biometric alert labels in ACCEPT_LABELS corpus', () => {
  it.each([
    ['Use Face ID', 'en'],
    ['Use Touch ID', 'en'],
    ['Continue with Face ID', 'en'],
    ['Face ID 사용', 'ko'],
    ['Touch ID 사용', 'ko'],
    ['Face IDを使用', 'ja'],
    ['使用面容 ID', 'zh-Hans'],
  ])('matches %s as accept (locale=%s)', (label, locale) => {
    const result = matchLabel(label, 'accept');
    expect(result).not.toBeNull();
    expect(result?.locale).toBe(locale);
  });

  it('keeps prior English Allow/OK/Continue labels working', () => {
    expect(ACCEPT_LABELS.en).toContain('Allow');
    expect(ACCEPT_LABELS.en).toContain('OK');
    expect(ACCEPT_LABELS.en).toContain('Continue');
  });
});
