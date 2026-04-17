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
const mockDiscoverVMServiceUrl = jest.fn();
const mockVMConnect = jest.fn();
const mockVMGetSemanticsTree = jest.fn();
const mockVMDisconnect = jest.fn();
const mockVMProbeEvaluateCompile = jest.fn();

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
    probeEvaluateCompile: (...args: unknown[]) => mockVMProbeEvaluateCompile(...args),
  })),
}));

// Import after mocks
import {
  ensureSemanticsActive,
  FlutterSemanticsUnavailableError,
  _clearNegativeCacheForTest,
} from '../../src/native/semantics-activator';

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
    _clearNegativeCacheForTest();
    // Default: VM Service is unavailable (release build or discovery misses)
    mockDiscoverVMServiceUrl.mockResolvedValue(null);
    mockVMConnect.mockResolvedValue({ connected: true });
    mockVMGetSemanticsTree.mockResolvedValue('populated');
    mockVMDisconnect.mockResolvedValue(undefined);
    mockVMProbeEvaluateCompile.mockResolvedValue({ available: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    _clearNegativeCacheForTest();
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

  // ── Hard timeout tests ──────────────────────────────────────────────────

  it('throws FlutterSemanticsUnavailableError(timeout) when VM connect never resolves', async () => {
    // Tree never populates
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    // VM discovery returns a URL but connect never resolves
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:50001/abc=/');
    mockVMConnect.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    // Attach the catch handler BEFORE advancing timers so the rejection is
    // handled synchronously when it fires (avoids PromiseRejectionHandledWarning).
    let capturedErr: unknown;
    const promise = ensureSemanticsActive('hanging-device', { timeout: 100 }).catch((e) => {
      capturedErr = e;
    });

    // Advance fake timers well past the per-call timeout so the error fires.
    await jest.advanceTimersByTimeAsync(6000);
    await promise;

    expect(capturedErr).toBeInstanceOf(FlutterSemanticsUnavailableError);
    expect(['timeout', 'no-dds']).toContain((capturedErr as FlutterSemanticsUnavailableError).reason);
  });

  it('throws FlutterSemanticsUnavailableError(timeout) within HARD_TIMEOUT_MS + 200 ms budget', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    const HARD_TIMEOUT_MS = 5000; // matches the module default

    let capturedErr: unknown;
    const promise = ensureSemanticsActive('slow-device', { timeout: 200 }).catch((e) => {
      capturedErr = e;
    });
    // Drive the fake clock past the hard ceiling
    await jest.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 200);
    await promise;

    expect(capturedErr).toBeInstanceOf(FlutterSemanticsUnavailableError);
    expect((capturedErr as FlutterSemanticsUnavailableError).reason).toBe('timeout');
  });

  // ── Negative cache tests ────────────────────────────────────────────────

  it('returns the cached negative result immediately on second call within TTL', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    // First call — hits the timeout path and caches the result.
    let err1: unknown;
    const p1 = ensureSemanticsActive('cached-device', { timeout: 200 }).catch((e) => { err1 = e; });
    await jest.advanceTimersByTimeAsync(6000);
    await p1;
    expect(err1).toBeInstanceOf(FlutterSemanticsUnavailableError);

    // Reset call counters so we can verify the second call does not re-probe.
    jest.clearAllMocks();
    mockDumpTree.mockResolvedValue(makeTree(2));

    // Second call — should throw immediately from cache, no dumpTree calls.
    let err2: unknown;
    const p2 = ensureSemanticsActive('cached-device', { timeout: 200 }).catch((e) => { err2 = e; });
    await p2;
    expect(err2).toBeInstanceOf(FlutterSemanticsUnavailableError);

    // The cache hit must not have called dumpTree again.
    expect(mockDumpTree).not.toHaveBeenCalled();
  });

  it('re-probes after the negative cache TTL expires', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue(null);

    // First call — populates cache.
    let err1: unknown;
    const p1 = ensureSemanticsActive('ttl-device', { timeout: 200 }).catch((e) => { err1 = e; });
    await jest.advanceTimersByTimeAsync(6000);
    await p1;
    expect(err1).toBeInstanceOf(FlutterSemanticsUnavailableError);

    // Advance past the 30 s TTL.
    await jest.advanceTimersByTimeAsync(31_000);

    // Second call after TTL — should re-probe (dumpTree is called again).
    jest.clearAllMocks();
    mockDumpTree.mockResolvedValue(makeTree(10)); // now the tree is populated

    const result = await ensureSemanticsActive('ttl-device', { timeout: 200 });
    expect(result).toBe(true);
    expect(mockDumpTree).toHaveBeenCalled();
  });

  // ── No-DDS fast-fail test ───────────────────────────────────────────────

  it('throws FlutterSemanticsUnavailableError(no-dds) when VM rejects with code 113', async () => {
    // Tree never populates via simctl.
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    // VM is discoverable and connects but probeEvaluateCompile returns 113.
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:50001/abc=/');
    mockVMConnect.mockResolvedValue({ connected: true });
    mockVMProbeEvaluateCompile.mockResolvedValue({
      available: false,
      reason: 'compile-error-113',
      message: 'VM Service error: method not found (code: 113)',
    });

    let capturedErr: unknown;
    const promise = ensureSemanticsActive('nodds-device', { timeout: 600 }).catch((e) => {
      capturedErr = e;
    });
    // Advance past the simctl poll window (half of 600 ms = 300 ms) so the
    // VM Service branch is reached, then let promises settle.
    await jest.advanceTimersByTimeAsync(2000);
    await promise;

    expect(capturedErr).toBeInstanceOf(FlutterSemanticsUnavailableError);
    expect((capturedErr as FlutterSemanticsUnavailableError).reason).toBe('no-dds');
    // Should not have called getSemanticsTree
    expect(mockVMGetSemanticsTree).not.toHaveBeenCalled();
    // Should have called disconnect (finally block)
    expect(mockVMDisconnect).toHaveBeenCalled();
  });

  // ── Happy-path regression ────────────────────────────────────────────────

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
    mockVMProbeEvaluateCompile.mockResolvedValue({ available: true });
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

    let capturedErr: unknown;
    const promise = ensureSemanticsActive('test-device-id', {
      timeout: 600,
      useVMServiceFallback: false,
    }).catch((e) => { capturedErr = e; });

    await jest.advanceTimersByTimeAsync(6000);
    await promise;

    expect(capturedErr).toBeInstanceOf(FlutterSemanticsUnavailableError);
    expect(mockDiscoverVMServiceUrl).not.toHaveBeenCalled();
  });

  it('swallows VM Service connect errors and still throws FlutterSemanticsUnavailableError gracefully', async () => {
    mockDumpTree.mockResolvedValue(makeTree(2));
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockDiscoverVMServiceUrl.mockResolvedValue('http://127.0.0.1:50001/abc=/');
    mockVMConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    let capturedErr: unknown;
    const promise = ensureSemanticsActive('test-device-id', { timeout: 1200 }).catch((e) => {
      capturedErr = e;
    });
    await jest.advanceTimersByTimeAsync(6000);
    await promise;

    expect(capturedErr).toBeInstanceOf(FlutterSemanticsUnavailableError);
    // disconnect() should still be attempted in the finally block
    expect(mockVMDisconnect).toHaveBeenCalled();
  });
});
