/**
 * Unit tests for Flutter Semantics Activator
 *
 * Tests the ensureSemanticsActive() function that forces Flutter apps
 * to populate their accessibility/semantics tree.
 */

import { countNodes, isLikelyChromeOnlyTree } from '../../src/native/semantics-activator';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDumpTree = jest.fn();
const mockExecFile = jest.fn();
const mockDiscoverVMServiceUrl = jest.fn();
const mockVMConnect = jest.fn();
const mockVMGetSemanticsTree = jest.fn();
const mockVMDisconnect = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: mockDumpTree,
  }),
}));

jest.mock('child_process', () => ({
  execFile: mockExecFile,
}));

jest.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

jest.mock('../../src/flutter/vm-service-discovery', () => ({
  discoverVMServiceUrl: (...args: unknown[]) => mockDiscoverVMServiceUrl(...args),
}));

jest.mock('../../src/flutter/vm-service-client', () => ({
  FlutterVMClient: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockVMConnect(...args),
    getSemanticsTree: (...args: unknown[]) => mockVMGetSemanticsTree(...args),
    disconnect: (...args: unknown[]) => mockVMDisconnect(...args),
  })),
}));

// Import after mocks
import { ensureSemanticsActive } from '../../src/native/semantics-activator';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTree(nodeCount: number): AXNode {
  const root: AXNode = {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [],
  };

  for (let i = 0; i < nodeCount - 1; i++) {
    root.children!.push({
      role: i % 2 === 0 ? 'AXButton' : 'AXStaticText',
      label: `Element ${i}`,
      traits: [],
      frame: { x: 10, y: 50 + i * 44, width: 370, height: 40 },
      visible: true,
      enabled: true,
      focused: false,
      path: `${i}`,
    });
  }

  return root;
}

function makeChromeOnlyTree(): AXNode {
  return {
    role: 'AXWindow',
    label: 'iPhone 16 Verify 2 – iOS 26.4',
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    children: [
      {
        role: 'AXButton',
        label: 'Action',
        traits: ['button'],
        frame: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0',
      },
      {
        role: 'AXButton',
        label: 'Volume Up',
        traits: ['button'],
        frame: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
        enabled: true,
        focused: false,
        path: '1',
      },
      {
        role: 'AXToolbar',
        traits: [],
        frame: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
        enabled: true,
        focused: false,
        path: '2',
        children: [
          {
            role: 'AXButton',
            label: 'Home',
            traits: ['button'],
            frame: { x: 0, y: 0, width: 10, height: 10 },
            visible: true,
            enabled: true,
            focused: false,
            path: '2/0',
          },
        ],
      },
      {
        role: 'AXStaticText',
        value: 'iPhone 16 Verify 2',
        traits: [],
        frame: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
        enabled: true,
        focused: false,
        path: '3',
      },
      {
        role: 'AXStaticText',
        value: 'iOS 26.4',
        traits: [],
        frame: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
        enabled: true,
        focused: false,
        path: '4',
      },
    ],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('countNodes', () => {
  it('counts a single node', () => {
    const node: AXNode = {
      role: 'AXGroup',
      traits: [],
      frame: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
    };
    expect(countNodes(node)).toBe(1);
  });

  it('counts nested nodes recursively', () => {
    const tree = makeTree(6);
    expect(countNodes(tree)).toBe(6);
  });

  it('counts deeply nested tree', () => {
    const root: AXNode = {
      role: 'AXGroup',
      traits: [],
      frame: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children: [{
        role: 'AXGroup',
        traits: [],
        frame: { x: 0, y: 0, width: 100, height: 100 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0',
        children: [{
          role: 'AXButton',
          label: 'Deep',
          traits: [],
          frame: { x: 0, y: 0, width: 100, height: 44 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0/0',
        }],
      }],
    };
    expect(countNodes(root)).toBe(3);
  });
});

describe('isLikelyChromeOnlyTree', () => {
  it('detects simulator chrome-only trees', () => {
    expect(isLikelyChromeOnlyTree(makeChromeOnlyTree())).toBe(true);
  });

  it('does not flag real app trees with identifiers as chrome-only', () => {
    const tree = makeTree(6);
    tree.children![0].identifier = 'login-btn';
    expect(isLikelyChromeOnlyTree(tree)).toBe(false);
  });
});

describe('ensureSemanticsActive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Default: VM Service is unavailable (release build or discovery misses)
    mockDiscoverVMServiceUrl.mockResolvedValue(null);
    mockVMConnect.mockResolvedValue({ connected: true });
    mockVMGetSemanticsTree.mockResolvedValue('populated');
    mockVMDisconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns true immediately when tree has enough nodes', async () => {
    mockDumpTree.mockResolvedValue(makeTree(10));

    const result = await ensureSemanticsActive('test-device-id');

    expect(result).toBe(true);
    // Should not call execFile (no activation needed)
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockDiscoverVMServiceUrl).not.toHaveBeenCalled();
  });

  it('returns true immediately when tree has exactly minNodes', async () => {
    mockDumpTree.mockResolvedValue(makeTree(5));

    const result = await ensureSemanticsActive('test-device-id');

    expect(result).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('attempts activation when tree is sparse', async () => {
    // First call: sparse tree (2 nodes)
    // Second call after activation: populated tree (10 nodes)
    mockDumpTree
      .mockResolvedValueOnce(makeTree(2))
      .mockResolvedValue(makeTree(10));

    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const promise = ensureSemanticsActive('test-device-id');

    // Advance past the poll interval
    await jest.advanceTimersByTimeAsync(400);

    const result = await promise;

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'spawn', 'test-device-id',
        'defaults', 'write', 'com.apple.Accessibility',
        'AccessibilityEnabled', '-bool', 'YES'],
      expect.objectContaining({ timeout: 5000 }),
    );
    // simctl succeeded — VM Service fallback must not have been invoked
    expect(mockDiscoverVMServiceUrl).not.toHaveBeenCalled();
  });

  it('treats chrome-only trees as unpopulated and attempts activation', async () => {
    mockDumpTree
      .mockResolvedValueOnce(makeChromeOnlyTree())
      .mockResolvedValue(makeTree(10));

    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const promise = ensureSemanticsActive('test-device-id');
    await jest.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('returns false on timeout when tree never populates', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    // VM Service also unavailable — covers release-build scenario
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    const promise = ensureSemanticsActive('test-device-id', { timeout: 600 });

    // Advance past timeout
    await jest.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result).toBe(false);
  });

  it('handles dumpTree failure gracefully on initial check', async () => {
    mockDumpTree
      .mockRejectedValueOnce(new Error('Bridge not found'))
      .mockResolvedValue(makeTree(10));

    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const promise = ensureSemanticsActive('test-device-id');
    await jest.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result).toBe(true);
  });

  it('handles execFile failure gracefully', async () => {
    mockDumpTree
      .mockResolvedValueOnce(makeTree(2))
      .mockResolvedValue(makeTree(10));

    mockExecFile.mockRejectedValue(new Error('simctl failed'));

    const promise = ensureSemanticsActive('test-device-id');
    await jest.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result).toBe(true);
  });

  it('respects custom minNodes threshold', async () => {
    mockDumpTree.mockResolvedValue(makeTree(3));

    const result = await ensureSemanticsActive('test-device-id', { minNodes: 3 });

    expect(result).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls back to VM Service when simctl path does not populate the tree', async () => {
    // Tree stays sparse across simctl poll window, populates after VM Service
    // fallback forces `getSemanticsTree()`.
    let semanticsDumped = false;
    mockDumpTree.mockImplementation(async () =>
      semanticsDumped ? makeTree(10) : makeTree(2),
    );
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:50001/abc=/');
    mockVMConnect.mockResolvedValue({ connected: true });
    mockVMGetSemanticsTree.mockImplementation(async () => {
      semanticsDumped = true;
      return 'populated';
    });

    const promise = ensureSemanticsActive('test-device-id', {
      timeout: 2000,
      bundleId: 'com.example.flutterApp',
    });

    await jest.advanceTimersByTimeAsync(2100);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockDiscoverVMServiceUrl).toHaveBeenCalledWith(
      'test-device-id',
      expect.objectContaining({ bundleId: 'com.example.flutterApp' }),
    );
    expect(mockVMConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        vmServiceUrl: 'http://127.0.0.1:50001/abc=/',
        deviceId: 'test-device-id',
        bundleId: 'com.example.flutterApp',
      }),
    );
    expect(mockVMGetSemanticsTree).toHaveBeenCalled();
    expect(mockVMDisconnect).toHaveBeenCalled();
  });

  it('skips VM Service fallback when useVMServiceFallback is false', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const promise = ensureSemanticsActive('test-device-id', {
      timeout: 600,
      useVMServiceFallback: false,
    });

    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(false);
    expect(mockDiscoverVMServiceUrl).not.toHaveBeenCalled();
  });

  it('swallows VM Service connect errors and still returns false gracefully', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:50001/abc=/');
    mockVMConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    const promise = ensureSemanticsActive('test-device-id', { timeout: 1200 });
    await jest.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toBe(false);
    // disconnect() should still be attempted in the finally block
    expect(mockVMDisconnect).toHaveBeenCalled();
  });
});
