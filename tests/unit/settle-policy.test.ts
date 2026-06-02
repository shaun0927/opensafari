import { evaluateSettleCondition, sampleSettleMatches, updateStableWindow } from '../../src/tools/settle-policy';
import type { AXNode } from '../../src/native';

const node: AXNode = {
  role: 'AXButton',
  label: 'Continue',
  identifier: 'continue',
  value: undefined,
  frame: { x: 0, y: 0, width: 44, height: 44 },
  visible: true,
  enabled: true,
  focused: false,
  traits: [],
  path: '/0/1',
  children: [],
};

describe('settle-policy helpers', () => {
  it('evaluates exists/not_exists/visible/enabled', () => {
    expect(evaluateSettleCondition([node], 'exists')).toBe(true);
    expect(evaluateSettleCondition([], 'not_exists')).toBe(true);
    expect(evaluateSettleCondition([{ ...node, visible: false }], 'visible')).toBe(false);
    expect(evaluateSettleCondition([{ ...node, enabled: false }], 'enabled')).toBe(false);
  });

  it('tracks stable windows and resets on broken condition', () => {
    const first = updateStableWindow(true, null, 100, 250);
    expect(first.stable).toBe(false);
    const stable = updateStableWindow(true, first.firstMetAtMs, 350, 250);
    expect(stable.stable).toBe(true);
    expect(updateStableWindow(false, stable.firstMetAtMs, 400, 250)).toEqual({ stable: false, firstMetAtMs: null, stableForMs: 0 });
  });

  it('samples bounded AX metadata', () => {
    expect(sampleSettleMatches([node], 1)).toEqual([{ role: 'AXButton', label: 'Continue', identifier: 'continue', visible: true, enabled: true, frame: node.frame, path: '/0/1' }]);
  });
});
