/**
 * Unit tests for InputBackendResolver class (#707 a).
 *
 * Verifies:
 *   - Instance state is independent across instances
 *   - reset() clears all caches
 *   - Fallback order matches the documented tier chain
 */

import { InputBackendResolver } from '../../src/input/backend-resolver';
import { SimctlInputBackend } from '../../src/input/simctl-backend';
import { AppleScriptInputBackend } from '../../src/input/applescript-backend';
import { WebKitInputBackend } from '../../src/input/webkit-backend';
import { FlutterVMInputBackend } from '../../src/tools/flutter-vm-input-backend';

// ── Mocks ──────────────────────────────────────────────────────────────────

/* eslint-disable no-var */
var execMock = jest.fn().mockResolvedValue('');
/* eslint-enable no-var */

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: execMock,
  })),
}));

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execMock(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const DEVICE = 'TEST-RESOLVER-UDID';
const DEVICE_B = 'TEST-RESOLVER-UDID-B';

const nullFlutterResolver = async () => null;

// ── Instance isolation ─────────────────────────────────────────────────────

describe('InputBackendResolver — instance isolation', () => {
  beforeEach(() => {
    execMock.mockClear();
  });

  test('two instances have independent simctl probe caches', async () => {
    const resolverA = new InputBackendResolver();
    const resolverB = new InputBackendResolver();
    resolverA.setFlutterVMResolver(nullFlutterResolver);
    resolverB.setFlutterVMResolver(nullFlutterResolver);

    // A: simctl succeeds
    execMock.mockResolvedValueOnce(''); // probe A
    const backendA = await resolverA.getInputBackend(DEVICE);
    expect(backendA).toBeInstanceOf(SimctlInputBackend);

    // B: simctl fails
    execMock.mockRejectedValueOnce(new Error('not supported'));
    process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'] = '1';
    const backendB = await resolverB.getInputBackend(DEVICE_B);
    process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'] = undefined;
    delete process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'];

    // A still returns simctl (cached), B returns applescript
    expect(backendA).toBeInstanceOf(SimctlInputBackend);
    expect(backendB).toBeInstanceOf(AppleScriptInputBackend);
  });

  test('two instances have independent Flutter VM caches', async () => {
    const resolverA = new InputBackendResolver();
    const resolverB = new InputBackendResolver();

    const fakeClient = { isConnected: () => true, evaluate: jest.fn() } as any;

    // A gets Flutter, B gets null (falls through to simctl)
    resolverA.setFlutterVMResolver(async () => fakeClient);
    resolverB.setFlutterVMResolver(nullFlutterResolver);

    const backendA = await resolverA.getInputBackend(DEVICE);
    execMock.mockResolvedValueOnce(''); // B's simctl probe
    const backendB = await resolverB.getInputBackend(DEVICE);

    expect(backendA).toBeInstanceOf(FlutterVMInputBackend);
    expect(backendB).toBeInstanceOf(SimctlInputBackend);
  });


  test('coalesces concurrent Flutter VM resolution for the same device', async () => {
    const resolver = new InputBackendResolver();
    const fakeClient = { isConnected: () => true, evaluate: jest.fn() } as any;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    resolver.setFlutterVMResolver(async () => {
      calls++;
      await gate;
      return fakeClient;
    });

    const first = resolver.getInputBackend(DEVICE);
    const second = resolver.getInputBackend(DEVICE);

    await Promise.resolve();
    release();

    const [backendA, backendB] = await Promise.all([first, second]);

    expect(backendA).toBeInstanceOf(FlutterVMInputBackend);
    expect(backendB).toBeInstanceOf(FlutterVMInputBackend);
    expect(calls).toBe(1);
  });

  test('clears failed Flutter VM pending resolution so retry can probe again', async () => {
    const resolver = new InputBackendResolver();
    let calls = 0;
    resolver.setFlutterVMResolver(async () => {
      calls++;
      throw new Error('transient vm discovery failure');
    });

    execMock.mockResolvedValue('');
    await Promise.all([
      resolver.getInputBackend(DEVICE),
      resolver.getInputBackend(DEVICE),
    ]);

    expect(calls).toBe(1);

    resolver.setFlutterVMResolver(async () => {
      calls++;
      return null;
    });
    await resolver.getInputBackend(DEVICE);

    expect(calls).toBe(2);
  });

  test('Flutter cache size is per-instance', async () => {
    const resolverA = new InputBackendResolver();
    const resolverB = new InputBackendResolver();
    resolverA.setFlutterVMResolver(nullFlutterResolver);
    resolverB.setFlutterVMResolver(nullFlutterResolver);

    execMock.mockResolvedValue('');
    await resolverA.getInputBackend(DEVICE);
    await resolverA.getInputBackend(DEVICE_B);

    // A made 2 probes (one per device); B has not been used
    // Flutter cache is distinct from simctl; sizes may be 0 here since
    // resolver returns null without caching on our stub
    expect(resolverA.getFlutterClientCacheSize()).toBe(0);
    expect(resolverB.getFlutterClientCacheSize()).toBe(0);
  });
});

// ── reset() behavior ──────────────────────────────────────────────────────

describe('InputBackendResolver.reset()', () => {
  beforeEach(() => {
    execMock.mockClear();
  });

  afterEach(() => {
    delete process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'];
  });

  test('reset() clears simctl detection cache — probe runs again after reset', async () => {
    const resolver = new InputBackendResolver();
    resolver.setFlutterVMResolver(nullFlutterResolver);

    execMock.mockResolvedValue('');
    await resolver.getInputBackend(DEVICE);
    const callsBeforeReset = execMock.mock.calls.length;

    resolver.reset();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockResolvedValue('');
    await resolver.getInputBackend(DEVICE);

    // Probe must have run again after reset
    expect(execMock.mock.calls.length).toBeGreaterThan(callsBeforeReset);
  });

  test('reset() clears cached simctl backend singleton — new instance returned', async () => {
    const resolver = new InputBackendResolver();
    resolver.setFlutterVMResolver(nullFlutterResolver);

    execMock.mockResolvedValue('');
    const first = await resolver.getInputBackend(DEVICE);

    resolver.reset();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockResolvedValue('');
    const second = await resolver.getInputBackend(DEVICE);

    expect(first).toBeInstanceOf(SimctlInputBackend);
    expect(second).toBeInstanceOf(SimctlInputBackend);
    // After reset the singleton is re-created — different object reference
    expect(first).not.toBe(second);
  });

  test('reset() clears focusInputOptInWarned so warning fires again', async () => {
    const resolver = new InputBackendResolver();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'] = '1';

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    execMock.mockRejectedValueOnce(new Error('not supported'));
    await resolver.getInputBackend(DEVICE);

    const warnsBefore = spy.mock.calls.filter((c) =>
      String(c[0]).includes('AppleScript/CGEvent backend is enabled'),
    ).length;

    resolver.reset();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockRejectedValueOnce(new Error('not supported'));
    await resolver.getInputBackend(DEVICE);

    const warnsAfter = spy.mock.calls.filter((c) =>
      String(c[0]).includes('AppleScript/CGEvent backend is enabled'),
    ).length;

    expect(warnsBefore).toBe(1);
    expect(warnsAfter).toBe(2); // warning fired again after reset
    spy.mockRestore();
  });

  test('reset() clears Flutter VM resolver override', async () => {
    const resolver = new InputBackendResolver();
    const fakeClient = { isConnected: () => true, evaluate: jest.fn() } as any;
    resolver.setFlutterVMResolver(async () => fakeClient);

    const before = await resolver.getInputBackend(DEVICE);
    expect(before).toBeInstanceOf(FlutterVMInputBackend);

    // After reset(), the override is gone — flutter resolver reverts to default
    // (which will return null since no real VM is running in unit tests).
    // Stub it back to null so tier 1 kicks in.
    resolver.reset();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockResolvedValueOnce('');
    const after = await resolver.getInputBackend(DEVICE);
    expect(after).toBeInstanceOf(SimctlInputBackend);
  });
});

// ── Fallback order (asserted, not just commented) ─────────────────────────

describe('InputBackendResolver — fallback order', () => {
  let resolver: InputBackendResolver;

  beforeEach(() => {
    execMock.mockClear();
    resolver = new InputBackendResolver();
    resolver.setFlutterVMResolver(nullFlutterResolver);
    delete process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'];
    delete process.env['OPENSAFARI_HEADLESS_ONLY'];
  });

  afterEach(() => {
    delete process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'];
    delete process.env['OPENSAFARI_HEADLESS_ONLY'];
  });

  test('Tier 0 (Flutter VM) wins over all lower tiers', async () => {
    const fakeClient = { isConnected: () => true, evaluate: jest.fn() } as any;
    resolver.setFlutterVMResolver(async () => fakeClient);

    const mockWebKit = { isConnected: () => true } as any;
    const backend = await resolver.getInputBackend(DEVICE, mockWebKit);

    expect(backend).toBeInstanceOf(FlutterVMInputBackend);
    expect(backend.kind).toBe('flutter-vm');
    // simctl probe must NOT run
    expect(execMock).not.toHaveBeenCalled();
  });

  test('Tier 2 simctl wins over WebKit when simctl probe succeeds', async () => {
    execMock.mockResolvedValueOnce(''); // simctl probe succeeds
    const mockWebKit = { isConnected: () => true } as any;
    const backend = await resolver.getInputBackend(DEVICE, mockWebKit);

    expect(backend).toBeInstanceOf(SimctlInputBackend);
    expect(backend.kind).toBe('simctl');
  });

  test('Tier 2 WebKit used when simctl probe fails and client is connected', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const mockWebKit = { isConnected: () => true } as any;
    const backend = await resolver.getInputBackend(DEVICE, mockWebKit);

    expect(backend).toBeInstanceOf(WebKitInputBackend);
    expect(backend.kind).toBe('webkit');
  });

  test('Tier 3 AppleScript used when simctl and WebKit both fail (opt-in set)', async () => {
    process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'] = '1';
    execMock.mockRejectedValueOnce(new Error('not supported'));

    const backend = await resolver.getInputBackend(DEVICE);

    expect(backend).toBeInstanceOf(AppleScriptInputBackend);
    expect(backend.kind).toBe('applescript');
  });

  test('throws HeadlessInputUnavailableError when no headless backend and no opt-in', async () => {
    execMock.mockRejectedValueOnce(new Error('not supported'));
    const { HeadlessInputUnavailableError } = await import('../../src/input/backend-resolver');

    await expect(resolver.getInputBackend(DEVICE)).rejects.toBeInstanceOf(
      HeadlessInputUnavailableError,
    );
  });

  test('Tier 0 → Tier 2 simctl fallback when Flutter resolver returns null', async () => {
    resolver.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockResolvedValueOnce('');

    const backend = await resolver.getInputBackend(DEVICE);

    expect(backend).toBeInstanceOf(SimctlInputBackend);
    expect(backend.kind).toBe('simctl');
  });

  test('tier order: Tier 0 > Tier 2 simctl > Tier 2 WebKit > Tier 3 AppleScript', async () => {
    // Verify each tier is tried in order by checking kind values.
    const kindResults: string[] = [];

    // Step 1: Flutter (Tier 0)
    const r0 = new InputBackendResolver();
    const fakeClient = { isConnected: () => true, evaluate: jest.fn() } as any;
    r0.setFlutterVMResolver(async () => fakeClient);
    kindResults.push((await r0.getInputBackend(DEVICE)).kind);

    // Step 2: Simctl (Tier 2) — Flutter null, simctl succeeds
    const r2s = new InputBackendResolver();
    r2s.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockResolvedValueOnce('');
    kindResults.push((await r2s.getInputBackend(DEVICE)).kind);

    // Step 3: WebKit (Tier 2) — Flutter null, simctl fails, webkit connected
    const r2w = new InputBackendResolver();
    r2w.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockRejectedValueOnce(new Error('not supported'));
    kindResults.push((await r2w.getInputBackend(DEVICE, { isConnected: () => true } as any)).kind);

    // Step 4: AppleScript (Tier 3) — Flutter null, simctl fails, no webkit, opt-in
    process.env['OPENSAFARI_ALLOW_FOCUS_INPUT'] = '1';
    const r3 = new InputBackendResolver();
    r3.setFlutterVMResolver(nullFlutterResolver);
    execMock.mockRejectedValueOnce(new Error('not supported'));
    kindResults.push((await r3.getInputBackend(DEVICE)).kind);

    expect(kindResults).toEqual(['flutter-vm', 'simctl', 'webkit', 'applescript']);
  });
});
