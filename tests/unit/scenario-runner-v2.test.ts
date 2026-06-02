import { ScenarioRunner } from '../../src/orchestration/scenario-runner';
import { waitForSettle } from '../../src/tools/settle-policy';

const queryMock = jest.fn();
const pressMock = jest.fn();
const tapMock = jest.fn();
const typeTextMock = jest.fn();

jest.mock('../../src/tools/app-state-snapshot', () => ({
  collectAppSessionState: jest.fn(async ({ deviceId }) => ({ schemaVersion: '1', device: { id: deviceId }, app: { classification: 'TARGET_BUNDLE_CONFIRMED' } })),
}));
jest.mock('../../src/tools/settle-policy', () => ({
  waitForSettle: jest.fn(async () => ({ met: true, polls: 1, elapsedMs: 1, stableForMs: 0, matchingCount: 1, lastObserved: [], errors: [] })),
}));
jest.mock('../../src/tools/debug-bundle-collect', () => ({
  collectDebugBundle: jest.fn(async ({ deviceId }) => ({ schemaVersion: '1', device: { udid: deviceId }, collectedAt: 'now' })),
}));
jest.mock('../../src/native', () => ({
  getAccessibilityBridge: () => ({
    query: queryMock,
    press: pressMock,
  }),
}));
jest.mock('../../src/tools/native-input-utils', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simhid',
    tap: tapMock,
    typeText: typeTextMock,
  })),
}));

const sim = {
  device: { udid: 'D1', name: 'iPhone' },
  preset: 'iphone',
  client: { screenshot: jest.fn(async () => Buffer.from('png')) },
  bootedAt: Date.now(),
  lastActivity: Date.now(),
};
const pool = { getAll: jest.fn(() => [sim]) };

describe('ScenarioRunner v2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryMock.mockResolvedValue({ matches: [{ path: '/0/1', frame: { x: 10, y: 20, width: 30, height: 40 } }] });
    pressMock.mockResolvedValue({ ok: true });
    (waitForSettle as jest.Mock).mockResolvedValue({ met: true, polls: 1, elapsedMs: 1, stableForMs: 0, matchingCount: 1, lastObserved: [], errors: [] });
  });
  it('records state with per-device result metadata', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'recordState', expectedBundleId: 'com.example' }] });
    expect(result.passed).toBe(true);
    expect(result.steps[0].devices[0].beforeState).toBeDefined();
    expect(result.steps[0].devices[0].selectedBackend).toBe('ax');
  });

  it('fails waitFor when the settle postcondition is unmet', async () => {
    (waitForSettle as jest.Mock).mockResolvedValueOnce({ met: false, polls: 2, elapsedMs: 50, stableForMs: 0, matchingCount: 0, lastObserved: [], errors: [] });
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'waitFor', query: { identifier: 'missing' } }] });
    expect(result.passed).toBe(false);
    expect(result.steps[0].devices[0].passed).toBe(false);
    expect(result.steps[0].devices[0].verification).toMatchObject({ met: false });
  });

  it('requires version 2 for mobile semantic actions', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', steps: [{ action: 'recordState' }] });
    expect(result.passed).toBe(false);
    expect(result.steps[0].devices[0].error).toContain('requires scenario.version === 2');
  });

  it('fails gotoScreen when no postcondition is supplied, even with a deeplink', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'gotoScreen', value: 'myapp://settings' }] });
    expect(result.passed).toBe(false);
    expect(result.steps[0].devices[0].error).toContain('gotoScreen requires a postcondition query');
  });


  it('fails tapElement before mutation when settle postcondition is omitted', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'tapElement', query: { identifier: 'menu' } }] });
    expect(result.passed).toBe(false);
    expect(result.steps[0].devices[0].error).toContain('tapElement requires a settle.query postcondition');
    expect(queryMock).not.toHaveBeenCalled();
    expect(tapMock).not.toHaveBeenCalled();
  });

  it('passes tapElement fallback only after settle verification succeeds and preserves AX evidence', async () => {
    pressMock.mockResolvedValueOnce({ ok: false, error: 'not pressable' });
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({
      name: 'mobile',
      version: 2,
      steps: [{ action: 'tapElement', query: { identifier: 'menu' }, settle: { query: { identifier: 'drawer' } } }],
    });
    expect(result.passed).toBe(true);
    expect(tapMock).toHaveBeenCalledWith('D1', 25, 40);
    expect(result.steps[0].devices[0].result).toMatchObject({ backend: 'simhid', axPress: { ok: false, error: 'not pressable' } });
    expect(result.steps[0].devices[0].verification).toMatchObject({ met: true });
  });

  it('fails typeElement before mutation when settle postcondition is omitted', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'typeElement', query: { identifier: 'email' }, value: 'agent@example.com' }] });
    expect(result.passed).toBe(false);
    expect(result.steps[0].devices[0].error).toContain('typeElement requires a settle.query postcondition');
    expect(queryMock).not.toHaveBeenCalled();
    expect(typeTextMock).not.toHaveBeenCalled();
  });

  it('records focus failure for typeElement but only passes when settle verification succeeds', async () => {
    pressMock.mockRejectedValueOnce(new Error('focus failed'));
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({
      name: 'mobile',
      version: 2,
      steps: [{ action: 'typeElement', query: { identifier: 'email' }, value: 'agent@example.com', settle: { query: { text: 'agent@example.com' } } }],
    });
    expect(result.passed).toBe(true);
    expect(typeTextMock).toHaveBeenCalledWith('D1', 'agent@example.com');
    expect(result.steps[0].devices[0].result).toMatchObject({ backend: 'simhid', focus: { ok: false, error: 'focus failed' } });
    expect(result.steps[0].devices[0].verification).toMatchObject({ met: true });
  });

  it('allows state-only gotoScreen when a postcondition is supplied', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'gotoScreen', query: { identifier: 'settings' } }] });
    expect(result.passed).toBe(true);
    expect(waitForSettle).toHaveBeenCalledWith('D1', expect.objectContaining({ query: { identifier: 'settings' } }));
  });
});
