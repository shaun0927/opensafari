/**
 * Unit tests for dumpTreeWithRecovery (issue #643).
 *
 * Covers: happy path, single-failure recovery, double-failure recovery,
 * exhaustion, non-recoverable short-circuit, backoff schedule, and
 * reactivation invocation contract.
 */

import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REACTIVATE_TIMEOUT_MS,
  NON_RECOVERABLE_ERROR_CODES,
  RECOVERABLE_ERROR_CODES,
  dumpTreeWithRecovery,
} from '../../src/native/ax-bridge-recovery';
import { AccessibilityBridgeError } from '../../src/native/accessibility-bridge';
import type { AccessibilityBridge } from '../../src/native/accessibility-bridge';
import type { AXNode } from '../../src/native/ax-types';

type DumpOutcome = AXNode | AccessibilityBridgeError;

function makeTree(label = 'root'): AXNode {
  return {
    role: 'AXApplication',
    label,
    traits: [],
    frame: { x: 0, y: 0, width: 0, height: 0 },
    visible: true,
    enabled: true,
    focused: true,
    path: '',
  };
}

function makeBridge(outcomes: DumpOutcome[]): {
  bridge: AccessibilityBridge;
  calls: number;
} {
  const state = { calls: 0 };
  const bridge = {
    dumpTree: jest.fn(async () => {
      const i = state.calls;
      state.calls += 1;
      if (i >= outcomes.length) throw new Error(`unexpected dumpTree call #${i + 1}`);
      const outcome = outcomes[i];
      if (outcome instanceof AccessibilityBridgeError) throw outcome;
      return outcome;
    }),
  } as unknown as AccessibilityBridge;
  return {
    bridge,
    get calls() {
      return state.calls;
    },
  };
}

describe('dumpTreeWithRecovery', () => {
  test('recoverable-code set matches the documented contract', () => {
    expect(RECOVERABLE_ERROR_CODES).toEqual(
      new Set(['DEVICE_CONTENT_ROOT_EMPTY', 'AX_TIMEOUT', 'BRIDGE_EXEC_FAILED', 'AX_ERROR']),
    );
    expect(NON_RECOVERABLE_ERROR_CODES).toEqual(
      new Set(['BRIDGE_NOT_FOUND', 'AX_PERMISSION_DENIED']),
    );
    expect(DEFAULT_BACKOFF_MS).toEqual([200, 500, 1200]);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });

  test('happy path returns on first dump with a trivial recovery report', async () => {
    const tree = makeTree('hello');
    const { bridge } = makeBridge([tree]);

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivate: async () => true,
      sleep: async () => {},
    });

    expect(result.tree).toBe(tree);
    expect(result.recovery).toMatchObject({ attempts: 1, recovered: true });
    expect(result.recovery.stages).toHaveLength(1);
    expect(result.recovery.stages[0]).toMatchObject({
      attempt: 1,
      action: 'dump',
      outcome: 'ok',
    });
  });

  test('single transient failure recovers on the second attempt', async () => {
    const tree = makeTree('after-retry');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
      tree,
    ]);
    const reactivate = jest.fn(async () => true);
    const sleeps: number[] = [];

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivate,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.tree).toBe(tree);
    expect(result.recovery.attempts).toBe(2);
    expect(result.recovery.recovered).toBe(true);
    const actions = result.recovery.stages.map((s) => s.action);
    expect(actions).toEqual(['dump', 'sleep', 'reactivate', 'dump']);
    expect(sleeps).toEqual([DEFAULT_BACKOFF_MS[0]]);
    expect(reactivate).toHaveBeenCalledWith('SIM-1', {
      forceRefresh: true,
      timeout: DEFAULT_REACTIVATE_TIMEOUT_MS,
      bundleId: undefined,
    });
  });

  test('double transient failure recovers on the third attempt and honours backoff order', async () => {
    const tree = makeTree('after-two-retries');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('timeout', 'AX_TIMEOUT'),
      new AccessibilityBridgeError('exec', 'BRIDGE_EXEC_FAILED'),
      tree,
    ]);
    const reactivate = jest.fn(async () => true);
    const sleeps: number[] = [];

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivate,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.recovery.attempts).toBe(3);
    expect(result.recovery.recovered).toBe(true);
    expect(sleeps).toEqual([DEFAULT_BACKOFF_MS[0], DEFAULT_BACKOFF_MS[1]]);
    expect(reactivate).toHaveBeenCalledTimes(2);
  });

  test('exhausting the retry budget re-throws the last error with recovery metadata', async () => {
    const errors = [
      new AccessibilityBridgeError('empty 1', 'DEVICE_CONTENT_ROOT_EMPTY'),
      new AccessibilityBridgeError('empty 2', 'DEVICE_CONTENT_ROOT_EMPTY'),
      new AccessibilityBridgeError('empty 3', 'DEVICE_CONTENT_ROOT_EMPTY'),
    ];
    const { bridge } = makeBridge(errors);

    await expect(
      dumpTreeWithRecovery(bridge, {
        deviceId: 'SIM-1',
        reactivate: async () => true,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({
      name: 'AccessibilityBridgeError',
      code: 'DEVICE_CONTENT_ROOT_EMPTY',
      message: 'empty 3',
    });
  });

  test('non-recoverable error short-circuits without retry', async () => {
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('denied', 'AX_PERMISSION_DENIED'),
    ]);
    const reactivate = jest.fn(async () => true);

    await expect(
      dumpTreeWithRecovery(bridge, {
        deviceId: 'SIM-1',
        reactivate,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'AX_PERMISSION_DENIED' });

    expect(bridge.dumpTree).toHaveBeenCalledTimes(1);
    expect(reactivate).not.toHaveBeenCalled();
  });

  test('reactivateOnRetry=false skips reactivation stages', async () => {
    const tree = makeTree('skip-reactivate');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('timeout', 'AX_TIMEOUT'),
      tree,
    ]);
    const reactivate = jest.fn(async () => true);

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivateOnRetry: false,
      reactivate,
      sleep: async () => {},
    });

    expect(result.recovery.recovered).toBe(true);
    expect(reactivate).not.toHaveBeenCalled();
    const actions = result.recovery.stages.map((s) => s.action);
    expect(actions).toEqual(['dump', 'sleep', 'dump']);
  });

  // Codex P2 regression on #653: `ensureSemanticsActive` resolves to `false`
  // when activation times out or silently fails. That outcome must reach the
  // recovery report as an error stage so telemetry does not mistake a silent
  // failure for a successful reactivation.
  test('records outcome: error when reactivate resolves false', async () => {
    const tree = makeTree('reactivate-false');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
      tree,
    ]);
    const reactivate = jest.fn(async () => false);

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivate,
      sleep: async () => {},
    });

    expect(result.recovery.recovered).toBe(true);
    const reactStage = result.recovery.stages.find((s) => s.action === 'reactivate');
    expect(reactStage).toMatchObject({
      outcome: 'error',
      errorCode: 'REACTIVATE_RETURNED_FALSE',
    });
  });

  test('reactivation failure does not abort the retry loop', async () => {
    const tree = makeTree('retry-anyway');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('timeout', 'AX_TIMEOUT'),
      tree,
    ]);
    const reactivate = jest.fn(async () => {
      throw new AccessibilityBridgeError('reactivate blew up', 'BRIDGE_EXEC_FAILED');
    });

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      reactivate,
      sleep: async () => {},
    });

    expect(result.recovery.recovered).toBe(true);
    const reactStage = result.recovery.stages.find((s) => s.action === 'reactivate');
    expect(reactStage).toMatchObject({ outcome: 'error', errorCode: 'BRIDGE_EXEC_FAILED' });
  });

  test('custom maxAttempts and backoffMs are honoured', async () => {
    const tree = makeTree('custom-budget');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('fail', 'AX_ERROR'),
      new AccessibilityBridgeError('fail', 'AX_ERROR'),
      new AccessibilityBridgeError('fail', 'AX_ERROR'),
      new AccessibilityBridgeError('fail', 'AX_ERROR'),
      tree,
    ]);
    const sleeps: number[] = [];

    const result = await dumpTreeWithRecovery(bridge, {
      deviceId: 'SIM-1',
      maxAttempts: 5,
      backoffMs: [10, 20],
      reactivate: async () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.recovery.attempts).toBe(5);
    // gapIndex 0 -> 10, gapIndex 1 -> 20, gapIndex 2+ -> last entry (20).
    expect(sleeps).toEqual([10, 20, 20, 20]);
  });

  test('absent deviceId skips reactivation even when reactivateOnRetry=true', async () => {
    const tree = makeTree('no-device');
    const { bridge } = makeBridge([
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
      tree,
    ]);
    const reactivate = jest.fn(async () => true);

    const result = await dumpTreeWithRecovery(bridge, {
      reactivate,
      sleep: async () => {},
    });

    expect(result.recovery.recovered).toBe(true);
    expect(reactivate).not.toHaveBeenCalled();
  });

  test('thrown error carries the recovery report for diagnostics', async () => {
    const errors = [
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
      new AccessibilityBridgeError('empty', 'DEVICE_CONTENT_ROOT_EMPTY'),
    ];
    const { bridge } = makeBridge(errors);

    let caught: (AccessibilityBridgeError & { recovery?: unknown }) | undefined;
    try {
      await dumpTreeWithRecovery(bridge, {
        deviceId: 'SIM-1',
        reactivate: async () => true,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err as AccessibilityBridgeError & { recovery?: unknown };
    }

    expect(caught).toBeInstanceOf(AccessibilityBridgeError);
    expect(caught?.recovery).toMatchObject({
      attempts: 3,
      recovered: false,
      lastErrorCode: 'DEVICE_CONTENT_ROOT_EMPTY',
    });
  });
});
