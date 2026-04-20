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

  it('ignores helper apps when deciding that the expected bundle is foreground', () => {
    const tree = node({
      children: [
        node({ role: 'AXTextField', label: '주소', path: '0' }),
        node({ role: 'AXButton', label: '뒤로', path: '1' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [
        { bundleId: 'com.apple.mobilesafari', pid: 10 },
        { bundleId: 'com.apple.iMessageAppsViewService', pid: 11 },
        { bundleId: 'com.apple.chrono.WidgetRenderer-Default', pid: 12 },
      ],
      expectedBundle: 'com.apple.mobilesafari',
    });

    expect(result.classification).toBe('TARGET_BUNDLE_CONFIRMED');
    expect(result.frontmost.bundleId).toBe('com.apple.mobilesafari');
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

  it('classifies springboard-like trees with an explicit springboard bundle', () => {
    const tree = node({
      children: [
        node({ role: 'AXButton', label: 'Safari', path: '0' }),
        node({ role: 'AXButton', label: '메시지', path: '1' }),
        node({ role: 'AXButton', label: '설정', path: '2' }),
        node({ role: 'AXButton', label: '사진', path: '3' }),
        node({ role: 'AXButton', label: '지도', path: '4' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [{ bundleId: 'com.apple.springboard', pid: 10 }],
      expectedBundle: 'com.example.target',
    });

    expect(result.classification).toBe('SPRINGBOARD_FOREGROUND');
    expect(result.frontmost.bundleId).toBe('com.apple.springboard');
    expect(result.expectedBundleMatched).toBe(false);
  });

  it('marks another foreground app as an expected-bundle mismatch', () => {
    const tree = node({
      children: [
        node({ role: 'AXStaticText', label: 'Dashboard', path: '0' }),
        node({ role: 'AXButton', label: 'Continue', path: '1' }),
      ],
    });

    const result = buildRawMobileContext({
      deviceId: 'device-1',
      tree,
      runningApps: [{ bundleId: 'com.example.other', pid: 4 }],
      expectedBundle: 'com.example.target',
    });

    expect(result.classification).toBe('EXPECTED_BUNDLE_MISMATCH');
    expect(result.frontmost.bundleId).toBe('com.example.other');
    expect(result.expectedBundleMatched).toBe(false);
    expect(result.verified).toBe(false);
  });
});
