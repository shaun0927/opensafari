import { classifyMobileContext } from '../../src/tools/mobile-context';
import type { AXNode } from '../../src/native/ax-types';

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [],
    ...overrides,
  };
}

describe('classifyMobileContext', () => {
  test('classifies simulator chrome by visible control labels', () => {
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Home', path: '0' }),
        makeNode({ role: 'AXButton', label: 'Save Screen', path: '1' }),
        makeNode({ role: 'AXButton', label: 'Rotate', path: '2' }),
      ],
    });

    const result = classifyMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [],
    });

    expect(result.surface).toBe('simulator_chrome');
    expect(result.contextVerified).toBe(true);
  });

  test('does NOT classify as chrome when only a single ambiguous label matches (e.g. a small app screen with one Home button)', () => {
    // A small real-app screen with a single "Home" button should remain app_content.
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXStaticText', label: 'Dashboard', path: '0' }),
        makeNode({ role: 'AXButton', label: 'Home', path: '1' }),
        makeNode({ role: 'AXButton', label: 'Profile', path: '2' }),
      ],
    });

    const result = classifyMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [],
    });

    expect(result.surface).toBe('app_content');
    expect(result.surface).not.toBe('simulator_chrome');
  });

  test('classifies as chrome when two or more ambiguous chrome labels are present', () => {
    // Both "home" and "action" together form a strong enough chrome signature.
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Home', path: '0' }),
        makeNode({ role: 'AXButton', label: 'Action', path: '1' }),
      ],
    });

    const result = classifyMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [],
    });

    expect(result.surface).toBe('simulator_chrome');
    expect(result.contextVerified).toBe(true);
  });

  test('classifies springboard-like icon grids', () => {
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Safari', path: '0' }),
        makeNode({ role: 'AXButton', label: '메시지', path: '1' }),
        makeNode({ role: 'AXButton', label: '설정', path: '2' }),
        makeNode({ role: 'AXButton', label: '사진', path: '3' }),
        makeNode({ role: 'AXButton', label: '지도', path: '4' }),
      ],
    });

    const result = classifyMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [],
      expectedBundle: 'com.example.app',
    });

    expect(result.surface).toBe('springboard_like');
    expect(result.inferredBundleId).toBe('com.apple.springboard');
    expect(result.expectedBundleMatch).toBe('mismatch');
    expect(result.expectedBundleMatchConfidence).toBe('verified');
  });

  test('heuristically matches a single running non-system app when surface looks app-owned', () => {
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXStaticText', label: 'Welcome back', path: '0' }),
        makeNode({ role: 'AXButton', label: 'Continue', path: '1' }),
      ],
    });

    const result = classifyMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [
        { bundleId: 'com.apple.mobilecal', pid: 1 },
        { bundleId: 'com.example.target', pid: 2 },
      ],
      expectedBundle: 'com.example.target',
    });

    expect(result.surface).toBe('app_content');
    expect(result.expectedBundleMatch).toBe('matched');
    expect(result.expectedBundleMatchConfidence).toBe('heuristic');
    expect(result.contextVerified).toBe(false);
  });
});
