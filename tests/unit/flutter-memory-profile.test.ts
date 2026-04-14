/**
 * Unit tests for flutter_allocation_profile + flutter_heap_snapshot (issue #440).
 */

import {
  parseAllocationProfile,
  diffAllocationEntries,
  collectHeapSnapshot,
  forgetAllocationHistory,
  _resetAllocationHistory,
  type AllocationEntry,
} from '../../src/tools/flutter-memory-profile';

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockCallMethod = jest.fn();
const mockGetState = jest.fn();
const mockStreamListen = jest.fn();
const mockOnEvent = jest.fn();
const mockOffEvent = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    callMethod: mockCallMethod,
    getState: mockGetState,
    streamListen: mockStreamListen,
    onEvent: mockOnEvent,
    offEvent: mockOffEvent,
  }),
  FlutterVMError: class extends Error {
    constructor(msg: string, public readonly code: string) { super(msg); }
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── parseAllocationProfile ──────────────────────────────────────────────────

describe('parseAllocationProfile', () => {
  it('drops classes with 0 live instances', () => {
    const entries = parseAllocationProfile({
      members: [
        { class: { name: 'A' }, instancesCurrent: 10, bytesCurrent: 100, accumulatedSize: 500 },
        { class: { name: 'Zero' }, instancesCurrent: 0, bytesCurrent: 0, accumulatedSize: 0 },
        { class: { name: 'B' }, instancesCurrent: 3, bytesCurrent: 24 },
      ],
    });
    expect(entries.map((e) => e.class)).toEqual(['A', 'B']);
  });

  it('pulls class name from classRef when class object is absent', () => {
    const entries = parseAllocationProfile({
      members: [
        { classRef: { name: 'Legacy' }, instancesCurrent: 2, bytesCurrent: 16 },
      ],
    });
    expect(entries[0].class).toBe('Legacy');
  });

  it('returns empty for malformed input', () => {
    expect(parseAllocationProfile(null)).toEqual([]);
    expect(parseAllocationProfile({})).toEqual([]);
    expect(parseAllocationProfile({ members: 'oops' })).toEqual([]);
  });

  it('skips rows with NaN counters', () => {
    const entries = parseAllocationProfile({
      members: [
        { class: { name: 'Bad' }, instancesCurrent: 'not-a-number', bytesCurrent: 10 },
      ],
    });
    expect(entries).toEqual([]);
  });
});

// ── diffAllocationEntries ───────────────────────────────────────────────────

describe('diffAllocationEntries', () => {
  it('computes per-class deltas', () => {
    const previous = new Map<string, AllocationEntry>([
      ['A', { class: 'A', instances_current: 5, bytes_current: 50 }],
      ['B', { class: 'B', instances_current: 2, bytes_current: 16 }],
    ]);
    const current: AllocationEntry[] = [
      { class: 'A', instances_current: 8, bytes_current: 80 },
      { class: 'B', instances_current: 2, bytes_current: 16 },
      { class: 'C', instances_current: 3, bytes_current: 24 },
    ];
    const diffed = diffAllocationEntries(current, previous);
    expect(diffed.find((e) => e.class === 'A')?.delta_instances).toBe(3);
    expect(diffed.find((e) => e.class === 'A')?.delta_bytes).toBe(30);
    expect(diffed.find((e) => e.class === 'B')?.delta_bytes).toBe(0);
    // New class => full delta
    expect(diffed.find((e) => e.class === 'C')?.delta_instances).toBe(3);
  });
});

// ── flutter_allocation_profile handler ──────────────────────────────────────

describe('flutter_allocation_profile', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterAllocationProfileTool } = require('../../src/tools/flutter-memory-profile');
    registerFlutterAllocationProfileTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetAllocationHistory();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('returns a top-N snapshot sorted by bytes_current', async () => {
    mockCallMethod.mockResolvedValue({
      members: [
        { class: { name: 'Small' }, instancesCurrent: 1, bytesCurrent: 8 },
        { class: { name: 'Big' }, instancesCurrent: 1, bytesCurrent: 1024 },
      ],
      memoryUsage: { heapUsage: 2048 },
    });

    const result = await handler('s', { top_n: 5 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.mode).toBe('snapshot');
    expect(body.entries[0].class).toBe('Big');
    expect(body.entries[1].class).toBe('Small');
    expect(body.memory_usage).toEqual({ heapUsage: 2048 });
  });

  it('forwards gc=true when gc_before is requested', async () => {
    mockCallMethod.mockResolvedValue({ members: [] });
    await handler('s', { gc_before: true });
    expect(mockCallMethod).toHaveBeenCalledWith('getAllocationProfile', {
      isolateId: 'iso-1',
      gc: true,
    });
  });

  it('does not forward gc when omitted', async () => {
    mockCallMethod.mockResolvedValue({ members: [] });
    await handler('s', {});
    expect(mockCallMethod).toHaveBeenCalledWith('getAllocationProfile', {
      isolateId: 'iso-1',
    });
  });

  it('clamps top_n to the [1, 1000] range', async () => {
    mockCallMethod.mockResolvedValue({ members: [] });
    await handler('s', { top_n: 1e6 }); // should not crash; silently clamped
    const result = await handler('s', { top_n: -5 }); // falls back to default
    expect(result.isError).toBeUndefined();
  });

  it('diff_against_previous returns deltas and persists baseline', async () => {
    // First call: baseline
    mockCallMethod.mockResolvedValueOnce({
      members: [{ class: { name: 'Leak' }, instancesCurrent: 1, bytesCurrent: 100 }],
    });
    const first = await handler('s', { diff_against_previous: true });
    const firstBody = JSON.parse(first.content[0].text);
    expect(firstBody.mode).toBe('diff');
    expect(firstBody.entries[0].delta_instances).toBe(1); // no previous -> treat as full delta

    // Second call: same class grew by 10
    mockCallMethod.mockResolvedValueOnce({
      members: [{ class: { name: 'Leak' }, instancesCurrent: 11, bytesCurrent: 1100 }],
    });
    const second = await handler('s', { diff_against_previous: true });
    const secondBody = JSON.parse(second.content[0].text);
    expect(secondBody.entries[0].delta_instances).toBe(10);
    expect(secondBody.entries[0].delta_bytes).toBe(1000);
    expect(typeof secondBody.previous_taken_at).toBe('number');
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });

  it('forgetAllocationHistory drops the per-device baseline', async () => {
    mockCallMethod.mockResolvedValueOnce({
      members: [{ class: { name: 'X' }, instancesCurrent: 1, bytesCurrent: 10 }],
    });
    await handler('s', { diff_against_previous: true });

    forgetAllocationHistory('test-device-id');

    mockCallMethod.mockResolvedValueOnce({
      members: [{ class: { name: 'X' }, instancesCurrent: 5, bytesCurrent: 50 }],
    });
    const result = await handler('s', { diff_against_previous: true });
    const body = JSON.parse(result.content[0].text);
    expect(body.previous_taken_at).toBeUndefined();
    expect(body.entries[0].delta_instances).toBe(5); // full delta (no baseline)
  });
});

// ── collectHeapSnapshot ─────────────────────────────────────────────────────

describe('collectHeapSnapshot', () => {
  it('concatenates base64 chunks until isLast and writes correct bytes', async () => {
    const listeners: Array<(ev: unknown) => void> = [];
    const fakeClient = {
      streamListen: jest.fn().mockResolvedValue(undefined),
      onEvent: (_s: string, cb: (ev: unknown) => void) => { listeners.push(cb); },
      offEvent: jest.fn(),
      callMethod: jest.fn().mockResolvedValue({}),
      getState: () => ({ mainIsolateId: 'iso-1' }),
    };

    const promise = collectHeapSnapshot(fakeClient, { timeoutMs: 5000 });

    // Simulate a three-chunk snapshot.
    const chunks = [Buffer.from([1, 2, 3]), Buffer.from([4, 5]), Buffer.from([6, 7, 8, 9])];
    listeners[0]({ kind: 'HeapSnapshot', bytes: chunks[0].toString('base64'), isLast: false });
    listeners[0]({ kind: 'HeapSnapshot', bytes: chunks[1].toString('base64'), isLast: false });
    listeners[0]({ kind: 'HeapSnapshot', bytes: chunks[2].toString('base64'), isLast: true });

    const buffer = await promise;
    expect(Array.from(buffer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fakeClient.callMethod).toHaveBeenCalledWith('requestHeapSnapshot', { isolateId: 'iso-1' });
    expect(fakeClient.offEvent).toHaveBeenCalled();
  });

  it('rejects with SNAPSHOT_TIMEOUT when isLast never arrives', async () => {
    jest.useFakeTimers();
    try {
      const fakeClient = {
        streamListen: jest.fn().mockResolvedValue(undefined),
        onEvent: jest.fn(),
        offEvent: jest.fn(),
        callMethod: jest.fn().mockResolvedValue({}),
        getState: () => ({ mainIsolateId: 'iso-1' }),
      };
      const p = collectHeapSnapshot(fakeClient, { timeoutMs: 100 });
      jest.advanceTimersByTime(100);
      await expect(p).rejects.toThrow('timed out');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores events with wrong kind', async () => {
    const listeners: Array<(ev: unknown) => void> = [];
    const fakeClient = {
      streamListen: jest.fn().mockResolvedValue(undefined),
      onEvent: (_s: string, cb: (ev: unknown) => void) => { listeners.push(cb); },
      offEvent: jest.fn(),
      callMethod: jest.fn().mockResolvedValue({}),
      getState: () => ({ mainIsolateId: 'iso-1' }),
    };
    const p = collectHeapSnapshot(fakeClient, { timeoutMs: 1000 });
    listeners[0]({ kind: 'OtherEvent', bytes: 'AA==', isLast: true }); // ignored
    listeners[0]({ kind: 'HeapSnapshot', bytes: Buffer.from([42]).toString('base64'), isLast: true });
    const buffer = await p;
    expect(Array.from(buffer)).toEqual([42]);
  });
});

// ── flutter_heap_snapshot handler (file I/O, minimal path) ──────────────────

describe('flutter_heap_snapshot handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterHeapSnapshotTool } = require('../../src/tools/flutter-memory-profile');
    registerFlutterHeapSnapshotTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
    mockStreamListen.mockResolvedValue(undefined);
    mockCallMethod.mockResolvedValue({});
  });

  it('rejects missing output_path', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('output_path is required');
  });

  it('writes chunks to disk and returns size_bytes', async () => {
    // Capture the listener the handler registers and feed it one isLast chunk.
    mockOnEvent.mockImplementation((_stream: string, cb: (ev: unknown) => void) => {
      // Defer one tick so the handler has time to request the snapshot.
      setImmediate(() => {
        cb({ kind: 'HeapSnapshot', bytes: Buffer.from('HELLO').toString('base64'), isLast: true });
      });
    });

    const outPath = path.join(os.tmpdir(), `opensafari-heap-${Date.now()}.bin`);
    try {
      const result = await handler('s', { output_path: outPath });
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.status).toBe('ok');
      expect(body.size_bytes).toBe(5);
      const written = await fs.readFile(outPath);
      expect(written.toString('utf8')).toBe('HELLO');
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  });
});
