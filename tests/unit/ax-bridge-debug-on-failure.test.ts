/**
 * Issue #842: opt-in `--debug` walker-topology re-capture on a recoverable
 * AX read failure.
 *
 * Two layers:
 *   1. Pure unit tests for `parseWalkerTopology` (no child process).
 *   2. Real-child-process integration via a Node fake shim (same pattern
 *      as `ax-bridge-recovery.fixture.test.ts`) asserting that:
 *        - a gated failure re-invokes with `--debug` and attaches topology,
 *        - an ungated failure does not re-invoke and leaves topology undefined,
 *        - the success path never invokes `--debug`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AccessibilityBridge,
  AccessibilityBridgeError,
  parseWalkerTopology,
} from '../../src/native/accessibility-bridge';

describe('parseWalkerTopology', () => {
  test('parses window enumeration, overlay roles, and winner from --debug stderr', () => {
    const stderr = [
      JSON.stringify({ event: 'invocation', command: 'dump' }),
      'not json — should be ignored',
      JSON.stringify({
        event: 'walker_app_windows_enumerated',
        count: 2,
        windows: [
          { role: 'AXWindow', subrole: 'AXStandardWindow', title: 'iPhone 17 Pro – iOS 26.4', identifier: '' },
          { role: 'AXMenuBar', subrole: '', title: '', identifier: '_NS:1311' },
        ],
      }),
      JSON.stringify({ event: 'walker_overlay_roles_seen', count: 0, samples: [] }),
      JSON.stringify({ event: 'walker_winner', depth: 1, role: 'AXGroup', label: null, score: 5, appSemanticsCount: 0 }),
    ].join('\n');

    const topology = parseWalkerTopology(stderr);

    expect(topology).toBeDefined();
    expect(topology!.windowCount).toBe(2);
    expect(topology!.windows).toHaveLength(2);
    expect(topology!.windows![0]).toMatchObject({ role: 'AXWindow', subrole: 'AXStandardWindow' });
    expect(topology!.overlayRolesSeen).toBe(0);
    expect(topology!.overlaySamples).toEqual([]);
    expect(topology!.winner).toMatchObject({ role: 'AXGroup', score: 5, appSemanticsCount: 0, label: null });
  });

  test('returns undefined when no walker_* events are present', () => {
    const stderr = [
      JSON.stringify({ event: 'invocation', command: 'dump' }),
      JSON.stringify({ event: 'ax_permission_check_done', trusted: true }),
    ].join('\n');
    expect(parseWalkerTopology(stderr)).toBeUndefined();
  });

  test('returns undefined for empty / missing stderr', () => {
    expect(parseWalkerTopology('')).toBeUndefined();
    expect(parseWalkerTopology(undefined)).toBeUndefined();
  });

  test('represents walker_winner_none as an explicit null winner', () => {
    const stderr = JSON.stringify({ event: 'walker_winner_none' });
    const topology = parseWalkerTopology(stderr);
    expect(topology).toBeDefined();
    expect(topology!.winner).toBeNull();
  });
});

const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'ax-bridge-fake', 'walker-topology.js');

// Bake the child-read env (FAKE_MODE / FAKE_AX_LOG) into the shim itself —
// same approach as ax-bridge-recovery.fixture.test.ts — so the test does
// not depend on process.env propagating through execFile to the grandchild.
// The parent-read gate (OPENSAFARI_AX_DEBUG_ON_FAILURE) is still set via
// process.env because the bridge reads it in-process.
function createShim(opts: { mode?: 'success'; errorCode?: string; logPath: string }): string {
  const shim = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ax-debug-on-failure-')),
    'ax-bridge-native',
  );
  const envAssignments = [
    opts.mode ? `FAKE_MODE=${JSON.stringify(opts.mode)}` : '',
    opts.errorCode ? `FAKE_ERROR_CODE=${JSON.stringify(opts.errorCode)}` : '',
    `FAKE_AX_LOG=${JSON.stringify(opts.logPath)}`,
  ]
    .filter(Boolean)
    .join(' ');
  const contents = `#!/usr/bin/env bash\n${envAssignments} exec "${process.execPath}" ${JSON.stringify(FIXTURE_PATH)} "$@"\n`;
  fs.writeFileSync(shim, contents, { mode: 0o755 });
  return shim;
}

function readLog(logPath: string): string[] {
  try {
    return fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe('AccessibilityBridge — #842 --debug topology on failure', () => {
  const createdDirs: string[] = [];
  let logPath: string;
  const savedGate = process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE;

  function makeBridge(mode?: 'success', errorCode?: string): AccessibilityBridge {
    const shimPath = createShim({ mode, errorCode, logPath });
    createdDirs.push(path.dirname(shimPath));
    return new AccessibilityBridge({ bridgePath: shimPath });
  }

  beforeEach(() => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-debug-on-failure-log-'));
    createdDirs.push(logDir);
    logPath = path.join(logDir, 'log.txt');
    delete process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE;
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    if (savedGate === undefined) delete process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE;
    else process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE = savedGate;
  });

  test('gated failure re-invokes with --debug and attaches parsed topology', async () => {
    process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE = '1';
    const bridge = makeBridge();

    const err = await bridge.dumpTree({ deviceId: 'FIXTURE-DEVICE' }).then(
      () => null,
      (e) => e as AccessibilityBridgeError,
    );

    expect(err).toBeInstanceOf(AccessibilityBridgeError);
    expect(err!.code).toBe('DEVICE_CONTENT_ROOT_EMPTY');
    expect(err!.topology).toBeDefined();
    expect(err!.topology!.windowCount).toBe(2);
    expect(err!.topology!.overlayRolesSeen).toBe(0);
    expect(err!.topology!.winner).toMatchObject({ appSemanticsCount: 0 });

    // Exactly two spawns: the original (plain) and the --debug re-capture.
    expect(readLog(logPath)).toEqual(['plain', 'debug']);
  });

  test('ungated failure does not re-invoke and leaves topology undefined', async () => {
    // OPENSAFARI_AX_DEBUG_ON_FAILURE intentionally unset.
    const bridge = makeBridge();

    const err = await bridge.dumpTree({ deviceId: 'FIXTURE-DEVICE' }).then(
      () => null,
      (e) => e as AccessibilityBridgeError,
    );

    expect(err).toBeInstanceOf(AccessibilityBridgeError);
    expect(err!.code).toBe('DEVICE_CONTENT_ROOT_EMPTY');
    expect(err!.topology).toBeUndefined();
    expect(readLog(logPath)).toEqual(['plain']);
  });

  test('gated non-recoverable failure does not re-invoke with --debug', async () => {
    process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE = '1';
    const bridge = makeBridge(undefined, 'DEVICE_RESOLUTION_FAILED');

    const err = await bridge.dumpTree({ deviceId: 'FIXTURE-DEVICE' }).then(
      () => null,
      (e) => e as AccessibilityBridgeError,
    );

    expect(err).toBeInstanceOf(AccessibilityBridgeError);
    expect(err!.code).toBe('DEVICE_RESOLUTION_FAILED');
    expect(err!.topology).toBeUndefined();
    expect(readLog(logPath)).toEqual(['plain']);
  });

  test('success path never invokes --debug even when gated', async () => {
    process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE = '1';
    const bridge = makeBridge('success');

    const tree = await bridge.dumpTree({ deviceId: 'FIXTURE-DEVICE' });

    expect(tree.label).toBe('FakeApp');
    expect(readLog(logPath)).toEqual(['plain']);
  });
});
