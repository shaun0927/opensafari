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
    expect(result.heuristics).toContain('chrome-labels:Home/Save Screen/Rotate');
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

  test('does not classify bare AXWindow roots as simulator chrome without toolbar labels', () => {
    const tree = makeTree({
      role: 'AXWindow',
      children: [
        makeTree({ role: 'AXStaticText', label: 'System Alert', path: '0' }),
        makeTree({ role: 'AXButton', label: 'Allow', path: '1' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('target-app');
  });

  test('does NOT classify in-app screen as springboard when it contains common app labels Safari and Messages', () => {
    // A chat/settings screen inside a real app may list "Safari" and "Messages" as navigation
    // items or in a share sheet — this should NOT trigger the springboard classifier.
    const tree = makeTree({
      role: 'AXScrollView',
      children: [
        makeTree({ role: 'AXStaticText', label: 'Share via', path: '0' }),
        makeTree({ role: 'AXButton', label: 'Safari', path: '1' }),
        makeTree({ role: 'AXButton', label: 'Messages', path: '2' }),
        makeTree({ role: 'AXTextField', label: 'Search', path: '3' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('target-app');
    expect(result.sourceKind).not.toBe('springboard');
  });

  test('does NOT classify an in-app settings list as springboard even with Settings and Messages labels', () => {
    const tree = makeTree({
      role: 'AXTableView',
      children: [
        makeTree({ role: 'AXCell', label: 'Messages', path: '0' }),
        makeTree({ role: 'AXCell', label: 'Settings', path: '1' }),
        makeTree({ role: 'AXCell', label: 'Profile', path: '2' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('target-app');
  });

  test('classifies SpringBoard via dock identifier + 3+ app icon labels', () => {
    // A real SpringBoard dump: has dock identifier and multiple known app icons
    const tree = makeTree({
      children: [
        makeTree({ role: 'AXGroup', identifier: 'dock', path: '0', children: [
          makeTree({ role: 'AXIcon', label: 'Safari', path: '0/0' }),
          makeTree({ role: 'AXIcon', label: 'Phone', path: '0/1' }),
          makeTree({ role: 'AXIcon', label: 'Messages', path: '0/2' }),
        ] }),
        makeTree({ role: 'AXIcon', label: 'Settings', path: '1' }),
        makeTree({ role: 'AXIcon', label: 'Mail', path: '2' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('springboard');
    expect(result.heuristics).toContain('springboard-identifier:dock');
  });

  test('classifies SpringBoard via com.apple.springboard bundle-id identifier', () => {
    const tree = makeTree({
      identifier: 'com.apple.springboard.HomeScreen',
      children: [
        makeTree({ role: 'AXIcon', label: 'Settings', path: '0' }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('springboard');
    expect(result.heuristics).toContain('springboard-bundle-id:com.apple.springboard');
  });

  test('does NOT classify as springboard when dock is present but fewer than 3 app icon labels match', () => {
    const tree = makeTree({
      children: [
        makeTree({ role: 'AXGroup', identifier: 'dock', path: '0', children: [
          makeTree({ role: 'AXIcon', label: 'Safari', path: '0/0' }),
          makeTree({ role: 'AXIcon', label: 'Messages', path: '0/1' }),
        ] }),
      ],
    });

    const result = classifyNativeContext(tree);
    expect(result.sourceKind).toBe('target-app');
  });
});
