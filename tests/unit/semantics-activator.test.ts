/**
 * Unit tests for Flutter Semantics Activator
 *
 * Tests the ensureSemanticsActive() function that forces Flutter apps
 * to populate their accessibility/semantics tree.
 */

import { countNodes } from '../../src/native/semantics-activator';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDumpTree = jest.fn();
const mockExecFile = jest.fn();

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

describe('ensureSemanticsActive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
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
  });

  it('returns false on timeout when tree never populates', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

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
});
