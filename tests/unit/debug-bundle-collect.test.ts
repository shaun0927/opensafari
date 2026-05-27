/**
 * #798 PR1 — debug_bundle_collect tests.
 *
 * Pins the schema, partial-failure tolerance, and option-respect
 * behaviour of the bundle collector. Tools that compose this in
 * #798 PR2 will rely on the schema version + the bundle's tolerant
 * shape.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      // simctl io <udid> screenshot <path> → args = [simctl, io, udid, screenshot, path]
      if (args[0] === 'simctl' && args[1] === 'io' && args[3] === 'screenshot') {
        const outPath = args[4];
        // Write a tiny placeholder so fs.stat succeeds.
        require('fs').writeFileSync(outPath, 'PNG');
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      // simctl spawn <udid> log show ... → args = [simctl, spawn, udid, log, show, ...]
      if (args[0] === 'simctl' && args[1] === 'spawn' && args[3] === 'log') {
        cb(null, { stdout: 'line1\nline2\nBearer abc.def.ghi\nline4\n', stderr: '' });
        return;
      }
      cb(new Error(`unexpected execFile: ${cmd} ${args.join(' ')}`), { stdout: '', stderr: '' });
    }),
  };
});

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'DEV-1',
    getSimulator: (udid: string) => ({ deviceId: udid, deviceType: 'iPhone 17 Pro', state: 'Booted' }),
  }),
}));

jest.mock('../../src/native', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: jest.fn(async () => ({
      role: 'AXApplication',
      label: 'Test',
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      visible: true,
      enabled: true,
      focused: false,
      path: '0',
      children: [
        { role: 'AXButton', traits: [], frame: { x: 0, y: 0, width: 40, height: 40 }, visible: true, enabled: true, focused: false, path: '0/0' },
      ],
    })),
  }),
}));

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: () => false,
    evaluate: async () => ({ valueAsString: '' }),
  }),
}));

jest.mock('../../src/tools/app-crash-reports', () => ({
  findFreshCrashes: jest.fn(async () => []),
}));

import {
  collectDebugBundle,
  DEBUG_BUNDLE_SCHEMA_VERSION,
  setDebugBundleActionTraceRecorder,
  type DebugBundle,
} from '../../src/tools/debug-bundle-collect';
import { ActionTraceRecorder } from '../../src/observability/action-trace';

function assertNoError(value: DebugBundle | { error: string }): asserts value is DebugBundle {
  if ('error' in value && typeof (value as { error?: unknown }).error === 'string') {
    throw new Error(`expected bundle, got error: ${(value as { error: string }).error}`);
  }
}

describe('collectDebugBundle (#798 PR1)', () => {
  afterEach(() => setDebugBundleActionTraceRecorder(null));

  it('returns the canonical schema and resolves the sole booted device', async () => {
    const bundle = await collectDebugBundle({ artifactDir: await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-debug-')) });
    assertNoError(bundle);
    expect(bundle.schemaVersion).toBe(DEBUG_BUNDLE_SCHEMA_VERSION);
    expect(bundle.schemaVersion).toBe('1');
    expect(bundle.device.udid).toBe('DEV-1');
    expect(bundle.device.name).toBe('iPhone 17 Pro');
    expect(bundle.session.soleDeviceId).toBe('DEV-1');
    expect(bundle.redactions.policy).toBe('default-v1');
  });

  it('returns a tolerant error envelope when no deviceId can be resolved', async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => ({
        getSoleDeviceId: () => null,
        getSimulator: () => null,
      }),
    }));
    const { collectDebugBundle: re } = await import('../../src/tools/debug-bundle-collect');
    const result = await re({});
    expect(result).toEqual(expect.objectContaining({ error: expect.stringMatching(/no booted device/) }));
    jest.dontMock('../../src/session-manager');
  });

  it('writes screenshot.png, ax-tree.json, logs.txt under artifactDir', async () => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-debug-'));
    const bundle = await collectDebugBundle({ artifactDir });
    assertNoError(bundle);
    const screenshot = bundle.screenshot as { path?: string };
    const ax = bundle.ax as { path?: string };
    const logs = bundle.logs as { path?: string };
    expect(screenshot.path).toBe(path.join(artifactDir, 'screenshot.png'));
    expect(ax.path).toBe(path.join(artifactDir, 'ax-tree.json'));
    expect(logs.path).toBe(path.join(artifactDir, 'logs.txt'));
    // Files exist
    await expect(fs.stat(screenshot.path!)).resolves.toBeDefined();
    await expect(fs.stat(ax.path!)).resolves.toBeDefined();
    await expect(fs.stat(logs.path!)).resolves.toBeDefined();
  });

  it('scrubs Bearer tokens from logs.tail and surfaces a redaction tag', async () => {
    const bundle = await collectDebugBundle({});
    assertNoError(bundle);
    const logs = bundle.logs as { tail: string };
    expect(logs.tail).toContain('Bearer [REDACTED]');
    expect(logs.tail).not.toContain('abc.def.ghi');
    expect(bundle.redactions.applied).toEqual(expect.arrayContaining(['logs.bearer']));
  });

  it('respects includeNetwork=false (default) by emitting skipped', async () => {
    const bundle = await collectDebugBundle({});
    assertNoError(bundle);
    expect(bundle.network).toEqual({ skipped: true });
  });

  it('respects includeFlutterRoute=false', async () => {
    const bundle = await collectDebugBundle({ includeFlutterRoute: false });
    assertNoError(bundle);
    expect(bundle.flutter).toEqual({ skipped: true });
  });

  it('reports flutter.connected=false when the VM client is not connected', async () => {
    const bundle = await collectDebugBundle({});
    assertNoError(bundle);
    const flutter = bundle.flutter as { connected: boolean };
    expect(flutter.connected).toBe(false);
  });

  it('includes recent events when a global action-trace recorder is registered', async () => {
    const recorder = new ActionTraceRecorder('test-run');
    recorder.record({
      action: 'app_tap_element',
      status: 'failed',
      context: 'native',
      startedAtMs: Date.now() - 1000,
      endedAtMs: Date.now() - 500,
    });
    setDebugBundleActionTraceRecorder(recorder);
    const bundle = await collectDebugBundle({ actionTraceWindowMs: 60_000 });
    assertNoError(bundle);
    expect(bundle.actionTrace.length).toBe(1);
    expect(bundle.actionTrace[0].action).toBe('app_tap_element');
    expect(bundle.actionTrace[0].status).toBe('failed');
  });
});
