import { computeBuildModeDisclosure } from '../../src/tools/flutter-connect';
import * as buildModeModule from '../../src/tools/flutter-build-mode';

// Mock only `detectBuildMode`; keep the real `capabilitiesFor` so the
// capability table stays the single source of truth under test.
jest.mock('../../src/tools/flutter-build-mode', () => {
  const actual = jest.requireActual('../../src/tools/flutter-build-mode');
  return { ...actual, detectBuildMode: jest.fn() };
});

const detectBuildMode = buildModeModule.detectBuildMode as jest.MockedFunction<
  typeof buildModeModule.detectBuildMode
>;

function fakeClient(available: boolean) {
  return { probeEvaluateCompile: jest.fn(async () => ({ available })) };
}

describe('computeBuildModeDisclosure (issue #831)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('debug build reports evaluate:true without issuing a probe', async () => {
    detectBuildMode.mockResolvedValue({ mode: 'debug', vmServiceAvailable: true, details: '' });
    const client = fakeClient(true);
    const r = await computeBuildModeDisclosure('udid', client);
    expect(r.buildMode).toBe('debug');
    expect(r.capabilities.evaluate).toBe(true);
    expect(r.evaluateProbed).toBe(false);
    expect(client.probeEvaluateCompile).not.toHaveBeenCalled();
  });

  it('no-compiler AOT (probe code-113) reports evaluate:false despite mode profile', async () => {
    // The false-positive guard: inference would say evaluate:true for profile.
    detectBuildMode.mockResolvedValue({ mode: 'profile', vmServiceAvailable: true, details: '' });
    const client = fakeClient(false);
    const r = await computeBuildModeDisclosure('udid', client);
    expect(r.buildMode).toBe('profile');
    expect(r.capabilities.evaluate).toBe(false);
    expect(r.evaluateProbed).toBe(true);
    expect(client.probeEvaluateCompile).toHaveBeenCalledTimes(1);
  });

  it('genuine profile with a live compiler reports evaluate:true', async () => {
    detectBuildMode.mockResolvedValue({ mode: 'profile', vmServiceAvailable: true, details: '' });
    const client = fakeClient(true);
    const r = await computeBuildModeDisclosure('udid', client);
    expect(r.capabilities.evaluate).toBe(true);
    expect(r.evaluateProbed).toBe(true);
  });

  it('unknown mode (VM discovered but not yet distinguished) still probes evaluate', async () => {
    // detectBuildMode's happy path can return 'unknown' (VM URL seen in logs
    // but debug-vs-profile not yet confirmed). This must still probe, not skip.
    detectBuildMode.mockResolvedValue({ mode: 'unknown', vmServiceAvailable: true, details: '' });
    const client = fakeClient(true);
    const r = await computeBuildModeDisclosure('udid', client);
    expect(r.buildMode).toBe('unknown');
    expect(r.capabilities.evaluate).toBe(true);
    expect(r.evaluateProbed).toBe(true);
    expect(client.probeEvaluateCompile).toHaveBeenCalledTimes(1);
  });

  it('detection failure degrades to unknown + no evaluate, never throws', async () => {
    detectBuildMode.mockRejectedValue(new Error('vm gone'));
    const client = fakeClient(true);
    const r = await computeBuildModeDisclosure('udid', client);
    expect(r.buildMode).toBe('unknown');
    expect(r.capabilities.evaluate).toBe(false);
    expect(r.evaluateProbed).toBe(false);
    expect(client.probeEvaluateCompile).not.toHaveBeenCalled();
  });
});
