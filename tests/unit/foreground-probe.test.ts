/**
 * Unit tests for getFrontmostBundleId (issue #644 WU1).
 */

import type { AXNode } from '../../src/native/ax-types';
import { getFrontmostBundleId } from '../../src/tools/foreground-probe';

function leaf(role: string, label: string, path: string): AXNode {
  return {
    role,
    label,
    traits: [],
    frame: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
    enabled: true,
    focused: false,
    path,
  };
}

function appRoot(): AXNode {
  return {
    role: 'AXWindow',
    label: 'Demo App',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      leaf('AXButton', 'Continue', '0/0'),
      leaf('AXStaticText', 'Hello', '0/1'),
      leaf('AXTextField', 'Name', '0/2'),
    ],
  };
}

function springboardRoot(): AXNode {
  return {
    role: 'AXWindow',
    label: 'SpringBoard',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      leaf('AXTextField', 'spotlight-pill', '0/0'),
      leaf('AXButton', 'Safari', '0/1'),
    ],
  };
}

function simulatorChromeRoot(): AXNode {
  return {
    role: 'AXWindow',
    label: 'Simulator',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      leaf('AXButton', 'Home', '0/0'),
      leaf('AXButton', 'Save Screen', '0/1'),
      leaf('AXButton', 'Rotate', '0/2'),
    ],
  };
}

function makeBridge(tree: AXNode | Error) {
  return {
    dumpTree: jest.fn(async () => {
      if (tree instanceof Error) throw tree;
      return tree;
    }),
  };
}

function makeManager(
  apps: Array<{ label: string; pid: number }> | Error,
) {
  return {
    listRunningApps: jest.fn(async () => {
      if (apps instanceof Error) throw apps;
      return apps;
    }),
  };
}

describe('getFrontmostBundleId', () => {
  it('returns SpringBoard with verified confidence when AX classification matches', async () => {
    const bridge = makeBridge(springboardRoot());
    const manager = makeManager([]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result).toEqual({
      bundleId: 'com.apple.springboard',
      confidence: 'verified',
      source: 'ax:springboard',
    });
    expect(manager.listRunningApps).not.toHaveBeenCalled();
  });

  it('returns null with verified confidence when the AX tree is the Simulator chrome', async () => {
    const bridge = makeBridge(simulatorChromeRoot());
    const manager = makeManager([]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result).toEqual({
      bundleId: null,
      confidence: 'verified',
      source: 'ax:simulator-window',
    });
    expect(manager.listRunningApps).not.toHaveBeenCalled();
  });

  it('returns the single running user app with heuristic confidence when AX shows app content', async () => {
    const bridge = makeBridge(appRoot());
    const manager = makeManager([
      { label: 'com.apple.springboard', pid: 1 },
      { label: 'com.example.target', pid: 42 },
      { label: 'com.apple.mobilecal', pid: 2 },
    ]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result).toEqual({
      bundleId: 'com.example.target',
      confidence: 'heuristic',
      source: 'running-apps:single',
    });
  });

  it('returns null with unknown confidence when multiple user apps are running', async () => {
    const bridge = makeBridge(appRoot());
    const manager = makeManager([
      { label: 'com.example.target', pid: 42 },
      { label: 'com.example.other', pid: 43 },
    ]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result.bundleId).toBeNull();
    expect(result.confidence).toBe('unknown');
    expect(result.source).toContain('running-apps:ambiguous:2');
  });

  it('returns null with unknown confidence when no user app is running', async () => {
    const bridge = makeBridge(appRoot());
    const manager = makeManager([
      { label: 'com.apple.springboard', pid: 1 },
    ]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result).toEqual({
      bundleId: null,
      confidence: 'unknown',
      source: 'running-apps:empty',
    });
  });

  it('falls back to running-apps when the AX dump fails', async () => {
    const bridge = makeBridge(new Error('bridge down'));
    const manager = makeManager([
      { label: 'com.example.target', pid: 42 },
    ]);

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result).toEqual({
      bundleId: 'com.example.target',
      confidence: 'heuristic',
      source: 'running-apps:single',
    });
  });

  it('returns unknown when both AX and listRunningApps fail', async () => {
    const bridge = makeBridge(new Error('bridge down'));
    const manager = makeManager(new Error('simctl down'));

    const result = await getFrontmostBundleId({
      deviceId: 'dev-1',
      bridge: bridge as never,
      manager: manager as never,
    });

    expect(result.bundleId).toBeNull();
    expect(result.confidence).toBe('unknown');
    expect(result.source).toBe('running-apps:error');
  });
});
