/**
 * Regression test for issue #46: when the native probe returns
 * `DEVICE_CONTENT_ROOT_EMPTY`, the `ax-bridge context` command coerces the
 * result to a synthetic empty AX tree and lets `buildRawMobileContext`
 * classify it as `FOREGROUND_CONTEXT_UNAVAILABLE`. That downgrade is what
 * lets the sim-hid-bridge wrapper's re-probe rule fire and promote to
 * `TRANSITIONAL_STATE_TIMEOUT`.
 *
 * The coercion itself lives in `cli/ax-bridge.ts` (not exported), but the
 * classifier behavior it depends on is what must stay stable: an empty
 * AXNode tree + running `expectedBundle` → `FOREGROUND_CONTEXT_UNAVAILABLE`
 * with `verified: false` and the running-apps list propagated. This is a
 * pure-function test; no simulator required.
 */

import type { AXNode } from '../../src/native/ax-types';
import { buildRawMobileContext } from '../../src/tools/raw-mobile-context';

function emptyTree(): AXNode {
  return {
    role: '',
    traits: [],
    frame: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    enabled: false,
    focused: false,
    children: [],
    path: '',
  };
}

describe('ax-bridge context empty-tree coercion (issue #46)', () => {
  it('classifies a synthetic empty AXNode tree as FOREGROUND_CONTEXT_UNAVAILABLE', () => {
    const result = buildRawMobileContext({
      deviceId: 'F19D0482-3539-4B74-A353-0229E415B64C',
      tree: emptyTree(),
      runningApps: [{ bundleId: 'com.example.app', pid: 4242 }],
      expectedBundle: 'com.example.app',
    });

    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
    expect(result.verified).toBe(false);
    expect(result.runningApps).toEqual([
      { bundleId: 'com.example.app', pid: 4242 },
    ]);
    expect(result.expectedBundle).toBe('com.example.app');
  });

  it('still returns FOREGROUND_CONTEXT_UNAVAILABLE when no expected bundle is supplied', () => {
    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree: emptyTree(),
      runningApps: [{ bundleId: 'com.example.app', pid: 1 }],
    });

    expect(result.classification).toBe('FOREGROUND_CONTEXT_UNAVAILABLE');
    expect(result.verified).toBe(false);
    expect(result.runningApps).toEqual([
      { bundleId: 'com.example.app', pid: 1 },
    ]);
  });
});
