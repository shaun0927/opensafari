import { evaluateWaitCondition, hasHeldStableSince } from '../../src/tools/app-wait-for';
import type { AXNode } from '../../src/native';

const baseNode: AXNode = {
  role: 'AXButton',
  label: 'Continue',
  identifier: 'continue_button',
  value: undefined,
  frame: { x: 0, y: 0, width: 44, height: 44 },
  visible: true,
  enabled: true,
  focused: false,
  traits: [],
  path: '/0/1',
  children: [],
};

describe('app_wait_for diagnostic helpers', () => {
  it('evaluates visible and enabled conditions', () => {
    expect(evaluateWaitCondition([{ ...baseNode, visible: false }], 'visible').met).toBe(false);
    expect(evaluateWaitCondition([{ ...baseNode, enabled: true }], 'enabled').met).toBe(true);
  });

  it('samples matches with bounded AX metadata', () => {
    const result = evaluateWaitCondition([baseNode, { ...baseNode, label: 'Cancel' }], 'exists', 1);
    expect(result.matchingCount).toBe(2);
    expect(result.sample).toEqual([{ role: 'AXButton', label: 'Continue', identifier: 'continue_button', visible: true, enabled: true, frame: baseNode.frame, path: '/0/1' }]);
  });

  it('supports not_exists conditions', () => {
    expect(evaluateWaitCondition([], 'not_exists').met).toBe(true);
    expect(evaluateWaitCondition([baseNode], 'not_exists').met).toBe(false);
  });

  it('requires a condition to hold for the requested stability window', () => {
    let state = hasHeldStableSince(true, null, 100, 250);
    expect(state.stable).toBe(false);
    state = hasHeldStableSince(true, state.firstMetAtMs, 349, 250);
    expect(state.stable).toBe(false);
    state = hasHeldStableSince(true, state.firstMetAtMs, 350, 250);
    expect(state.stable).toBe(true);
    expect(hasHeldStableSince(false, state.firstMetAtMs, 400, 250)).toEqual({ stable: false, firstMetAtMs: null, stableForMs: 0 });
  });
});

describe('app_wait_for stability reset contract', () => {
  it('treats an unobserved poll as a broken stability window', () => {
    const first = hasHeldStableSince(true, null, 100, 250);
    expect(first.firstMetAtMs).toBe(100);
    const reset = hasHeldStableSince(false, first.firstMetAtMs, 200, 250);
    expect(reset).toEqual({ stable: false, firstMetAtMs: null, stableForMs: 0 });
    const afterError = hasHeldStableSince(true, reset.firstMetAtMs, 300, 250);
    expect(afterError.stable).toBe(false);
    expect(afterError.firstMetAtMs).toBe(300);
  });
});
