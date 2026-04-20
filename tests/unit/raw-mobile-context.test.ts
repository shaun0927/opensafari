import type { AXNode } from '../../src/native/ax-types';
import { buildRawMobileContext } from '../../src/tools/raw-mobile-context';

function node(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXWindow',
    label: 'Root',
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

describe('raw mobile context projection', () => {
  it('marks simulator chrome as unverified foreground metadata', () => {
    const tree = node({
      children: [
        node({ role: 'AXButton', label: 'Home', path: '0' }),
        node({ role: 'AXButton', label: 'Save Screen', path: '1' }),
        node({ role: 'AXButton', label: 'Rotate', path: '2' }),
        node({ role: 'AXButton', label: 'Action', path: '3' }),
        node({ role: 'AXButton', label: 'Volume Up', path: '4' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [{ bundleId: 'com.example.app', pid: 1 }],
      expectedBundle: 'com.example.app',
    });

    expect(result.classification).toBe('SIMULATOR_CHROME_FOREGROUND');
    expect(result.verified).toBe(false);
    expect(result.expectedBundleMatched).toBe(false);
  });

  it('confirms the expected bundle when app content is heuristic-singleton foreground', () => {
    const tree = node({
      children: [
        node({ role: 'AXStaticText', label: 'Hello', path: '0' }),
        node({ role: 'AXButton', label: 'Continue', path: '1' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [{ bundleId: 'com.example.app', pid: 2 }],
      expectedBundle: 'com.example.app',
    });

    expect(result.classification).toBe('TARGET_BUNDLE_CONFIRMED');
    expect(result.verified).toBe(true);
    expect(result.frontmost.bundleId).toBe('com.example.app');
    expect(result.expectedBundleMatched).toBe(true);
  });

  it('falls back to unverified app content when no expected bundle is provided', () => {
    const tree = node({
      children: [
        node({ role: 'AXTextField', label: 'Email', path: '0' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [{ bundleId: 'com.example.app', pid: 3 }],
    });

    expect(result.classification).toBe('APP_CONTENT_FOREGROUND');
    expect(result.frontmost.bundleId).toBe('com.example.app');
  });
});
