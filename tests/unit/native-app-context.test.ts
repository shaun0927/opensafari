import { classifyNativeContext } from '../../src/tools/native-app-context';
import type { AXNode } from '../../src/native/ax-types';

function makeTree(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [],
    ...overrides,
  };
}

describe('native app context classification', () => {
  test('classifies simulator window chrome', () => {
    const tree = makeTree({
      role: 'AXWindow',
      children: [
        makeTree({ role: 'AXButton', label: 'Home', path: '0' }),
        makeTree({ role: 'AXButton', label: 'Save Screen', path: '1' }),
        makeTree({ role: 'AXButton', label: 'Rotate', path: '2' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('simulator-window');
    expect(result.heuristics).toContain('root-role:AXWindow');
  });

  test('classifies springboard via spotlight pill heuristic', () => {
    const tree = makeTree({
      children: [
        makeTree({ role: 'AXSlider', label: '검색', identifier: 'spotlight-pill', path: '0' }),
        makeTree({ role: 'AXButton', label: 'Safari', path: '1' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('springboard');
  });

  test('defaults to target-app when no chrome/springboard heuristics match', () => {
    const tree = makeTree({
      children: [
        makeTree({ role: 'AXStaticText', label: 'Create Account', path: '0' }),
        makeTree({ role: 'AXButton', label: 'Continue', path: '1' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('target-app');
  });
});
