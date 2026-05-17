/**
 * End-to-end-ish integration test for the ax-bridge recovery wrapper
 * (issue #643).
 *
 * Spawns a real child process — a Node fake at
 * `tests/fixtures/ax-bridge-fake/fail-once.js` — in place of the Swift
 * `ax-bridge-native` binary. The fake fails on the first invocation with
 * the exact `DEVICE_CONTENT_ROOT_EMPTY` contract the real binary emits,
 * and succeeds on the second invocation. The test asserts that
 * `dumpTreeWithRecovery` actually re-spawns the binary and recovers with
 * a correctly populated `AxBridgeRecoveryReport`.
 *
 * This complements the pure unit tests in `ax-bridge-recovery.test.ts`
 * (which mock the bridge entirely) by exercising the real `execFile`
 * path, JSON parsing, stderr-error handling, and error classification.
 * Placed under `tests/unit/` because `tests/integration/` is excluded
 * from `jest` per `jest.config.js`; the test requires no simulator and
 * no macOS-specific tooling.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AccessibilityBridge } from '../../src/native/accessibility-bridge';
import {
  DEFAULT_BACKOFF_MS,
  dumpTreeWithRecovery,
} from '../../src/native/ax-bridge-recovery';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'ax-bridge-fake',
  'fail-once.js',
);

// The fake is `fail-once.js`; we launch it via `node`. Simplest way to
// point `execFile` at "a node script that pretends to be ax-bridge" is
// to create a shell shim that invokes `node <fixture>` on every call.
function createShim(counterPath: string): string {
  const shim = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ax-bridge-recovery-fixture-')),
    'ax-bridge-native',
  );
  const contents = `#!/usr/bin/env bash\nFAKE_AX_COUNTER=${JSON.stringify(counterPath)} exec "${process.execPath}" ${JSON.stringify(FIXTURE_PATH)} "$@"\n`;
  fs.writeFileSync(shim, contents, { mode: 0o755 });
  return shim;
}

describe('dumpTreeWithRecovery — real child process fixture', () => {
  let counterPath: string;
  let shimPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-bridge-recovery-counter-'));
    counterPath = path.join(tmpDir, 'counter.txt');
    shimPath = createShim(counterPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(shimPath), { recursive: true, force: true });
      fs.rmSync(path.dirname(counterPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('recovers from a first-invocation DEVICE_CONTENT_ROOT_EMPTY failure on the second spawn', async () => {
    const bridge = new AccessibilityBridge({ bridgePath: shimPath });

    const { tree, recovery } = await dumpTreeWithRecovery(bridge, {
      deviceId: 'FIXTURE-DEVICE',
      // Avoid the real ensureSemanticsActive (which would spawn simctl).
      reactivate: async () => true,
      // Shrink backoff so the test runs fast while still exercising the sleep path.
      backoffMs: [10],
      sleep: async () => {},
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.attempts).toBe(2);
    expect(tree.role).toBe('AXApplication');
    expect(tree.label).toBe('FakeApp');
    expect(tree.children?.[0]?.label).toBe('Recovered');

    // Counter file must show the fake was spawned twice.
    const counterValue = parseInt(fs.readFileSync(counterPath, 'utf-8'), 10);
    expect(counterValue).toBe(2);

    // First stage = failed dump, last stage = successful dump.
    expect(recovery.stages[0]).toMatchObject({
      action: 'dump',
      outcome: 'error',
      errorCode: 'DEVICE_CONTENT_ROOT_EMPTY',
    });
    const lastStage = recovery.stages[recovery.stages.length - 1];
    expect(lastStage).toMatchObject({ action: 'dump', outcome: 'ok' });
  });

  test('trivial happy-path (already-primed counter) still returns a single-dump recovery report', async () => {
    // Pre-seed counter to 1 so the next invocation is the success path.
    fs.writeFileSync(counterPath, '1');
    const bridge = new AccessibilityBridge({ bridgePath: shimPath });

    const { recovery } = await dumpTreeWithRecovery(bridge, {
      deviceId: 'FIXTURE-DEVICE',
      reactivate: async () => true,
      sleep: async () => {},
    });

    expect(recovery.attempts).toBe(1);
    expect(recovery.recovered).toBe(true);
    expect(recovery.stages).toHaveLength(1);
    expect(recovery.stages[0]).toMatchObject({ action: 'dump', outcome: 'ok' });
  });

  test('default backoff schedule is used when no override is provided', () => {
    // Regression guard: the first entry in the default schedule drives
    // the single-failure path exercised above. Keep this in sync with
    // the documented contract.
    expect(DEFAULT_BACKOFF_MS[0]).toBe(200);
  });
});
