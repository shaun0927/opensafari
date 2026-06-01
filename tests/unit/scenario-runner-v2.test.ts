import { ScenarioRunner } from '../../src/orchestration/scenario-runner';
import { waitForSettle } from '../../src/tools/settle-policy';

jest.mock('../../src/tools/app-state-snapshot', () => ({
  collectAppSessionState: jest.fn(async ({ deviceId }) => ({ schemaVersion: '1', device: { id: deviceId }, app: { classification: 'TARGET_BUNDLE_CONFIRMED' } })),
}));
jest.mock('../../src/tools/settle-policy', () => ({
  waitForSettle: jest.fn(async () => ({ met: true, polls: 1, elapsedMs: 1, stableForMs: 0, matchingCount: 1, lastObserved: [], errors: [] })),
}));
jest.mock('../../src/tools/debug-bundle-collect', () => ({
  collectDebugBundle: jest.fn(async ({ deviceId }) => ({ schemaVersion: '1', device: { udid: deviceId }, collectedAt: 'now' })),
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

  it('allows state-only gotoScreen when a postcondition is supplied', async () => {
    const runner = new ScenarioRunner(pool as any);
    const result = await runner.run({ name: 'mobile', version: 2, steps: [{ action: 'gotoScreen', query: { identifier: 'settings' } }] });
    expect(result.passed).toBe(true);
    expect(waitForSettle).toHaveBeenCalledWith('D1', expect.objectContaining({ query: { identifier: 'settings' } }));
  });
});
