/**
 * Unit tests for flutter_track_rebuilds (issue #438).
 */

import {
  mergeRebuildEvent,
  buildReport,
  _resetTrackers,
  type TrackerState,
} from '../../src/tools/flutter-track-rebuilds';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockCallServiceExtension = jest.fn();
const mockStreamListen = jest.fn();
const mockOnEvent = jest.fn();
const mockOffEvent = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    callServiceExtension: mockCallServiceExtension,
    streamListen: mockStreamListen,
    onEvent: mockOnEvent,
    offEvent: mockOffEvent,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── mergeRebuildEvent ───────────────────────────────────────────────────────

function newState(): TrackerState {
  return {
    deviceId: 'test',
    startedAt: 1000,
    subscribed: true,
    counts: new Map(),
    locations: new Map(),
    eventCount: 0,
    listener: () => {},
  };
}

describe('mergeRebuildEvent', () => {
  it('parses flat [locId, count, locId, count, ...] events', () => {
    const s = newState();
    const added = mergeRebuildEvent(s, {
      events: [1, 5, 2, 3, 1, 2],
      locations: { '1': { file: 'a.dart', line: 10, name: 'MyWidget' } },
    });
    expect(added).toBe(10);
    expect(s.counts.get(1)).toBe(7);
    expect(s.counts.get(2)).toBe(3);
    expect(s.locations.get(1)?.name).toBe('MyWidget');
  });

  it('parses nested [[locId, count], ...] events', () => {
    const s = newState();
    mergeRebuildEvent(s, {
      events: [[3, 4], [3, 1], [4, 2]],
      locations: { '3': { file: 'b.dart' } },
    });
    expect(s.counts.get(3)).toBe(5);
    expect(s.counts.get(4)).toBe(2);
  });

  it('ignores malformed entries without crashing', () => {
    const s = newState();
    mergeRebuildEvent(s, { events: [['x', 'y'], [1]], locations: {} });
    expect(s.counts.size).toBe(0);
    expect(s.eventCount).toBe(1);
  });

  it('accumulates location metadata across events', () => {
    const s = newState();
    mergeRebuildEvent(s, { events: [1, 1], locations: { '1': { file: 'a.dart', line: 5, name: 'A' } } });
    mergeRebuildEvent(s, { events: [1, 2], locations: {} }); // second event lacks locations
    expect(s.locations.get(1)?.line).toBe(5);
    expect(s.counts.get(1)).toBe(3);
  });

  it('tolerates missing events/locations fields', () => {
    const s = newState();
    mergeRebuildEvent(s, {});
    expect(s.eventCount).toBe(1);
  });

  it('returns 0 and does not crash on non-object input', () => {
    const s = newState();
    expect(mergeRebuildEvent(s, null)).toBe(0);
    expect(mergeRebuildEvent(s, 'foo')).toBe(0);
    expect(s.eventCount).toBe(0);
  });
});

// ── buildReport ─────────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('sorts descending by rebuild_count and trims to topN', () => {
    const s = newState();
    s.counts.set(1, 3);
    s.counts.set(2, 10);
    s.counts.set(3, 5);
    s.locations.set(2, { id: 2, file: 'hot.dart', line: 42, name: 'HotWidget' });

    const report = buildReport(s, 2);
    expect(report.entries).toHaveLength(2);
    expect((report.entries as Array<{ rebuild_count: number }>)[0].rebuild_count).toBe(10);
    expect((report.entries as Array<{ widget: string }>)[0].widget).toBe('HotWidget');
    expect((report.entries as Array<{ rebuild_count: number }>)[1].rebuild_count).toBe(5);
  });

  it('reports total_rebuilds and elapsed_ms', () => {
    const s = newState();
    s.counts.set(1, 2);
    s.counts.set(2, 3);
    s.eventCount = 7;
    const report = buildReport(s, 10);
    expect(report.total_rebuilds).toBe(5);
    expect(report.event_count).toBe(7);
    expect(typeof report.elapsed_ms).toBe('number');
  });

  it('handles empty counts cleanly', () => {
    const s = newState();
    const report = buildReport(s, 10);
    expect(report.entries).toEqual([]);
    expect(report.total_rebuilds).toBe(0);
  });
});

// ── handler ─────────────────────────────────────────────────────────────────

describe('flutter_track_rebuilds handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterTrackRebuildsTool } = require('../../src/tools/flutter-track-rebuilds');
    registerFlutterTrackRebuildsTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetTrackers();
    mockIsConnected.mockReturnValue(true);
    mockCallServiceExtension.mockResolvedValue({});
    mockStreamListen.mockResolvedValue(undefined);
  });

  it('registers with the expected name and required action', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterTrackRebuildsTool } = require('../../src/tools/flutter-track-rebuilds');
    registerFlutterTrackRebuildsTool(server);
    const def = server.registerTool.mock.calls[0][0];
    expect(def.name).toBe('flutter_track_rebuilds');
    expect(def.inputSchema.required).toEqual(['action']);
  });

  it('start subscribes to the Extension stream and enables the extension', async () => {
    const result = await handler('s', { action: 'start' });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('started');
    expect(mockStreamListen).toHaveBeenCalledWith('Extension');
    expect(mockOnEvent).toHaveBeenCalledWith('Extension', expect.any(Function));
    expect(mockCallServiceExtension).toHaveBeenCalledWith(
      'inspector.trackRebuildDirtyWidgets',
      { enabled: 'true' },
    );
  });

  it('start twice in a row rejects with a clear error', async () => {
    await handler('s', { action: 'start' });
    const second = await handler('s', { action: 'start' });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('already active');
  });

  it('report without an active tracker errors', async () => {
    const result = await handler('s', { action: 'report' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active tracker');
  });

  it('report aggregates events ingested via the registered listener', async () => {
    await handler('s', { action: 'start' });
    const registeredListener = mockOnEvent.mock.calls[0][1] as (ev: unknown) => void;

    registeredListener({
      extensionKind: 'Flutter.RebuildWidgets',
      extensionData: {
        events: [1, 10, 2, 1],
        locations: { '1': { file: 'hot.dart', line: 5, name: 'Hot' } },
      },
    });
    registeredListener({
      extensionKind: 'Flutter.RebuildWidgets',
      extensionData: { events: [1, 2], locations: {} },
    });
    // Unrelated extension events must be ignored
    registeredListener({
      extensionKind: 'Flutter.FrameworkInitialization',
      extensionData: {},
    });

    const result = await handler('s', { action: 'report', top_n: 5 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.report.entries[0]).toMatchObject({
      widget: 'Hot',
      file: 'hot.dart',
      line: 5,
      rebuild_count: 12,
    });
    expect(body.report.total_rebuilds).toBe(13);
    expect(body.report.event_count).toBe(2);
  });

  it('stop disables the extension and unsubscribes', async () => {
    await handler('s', { action: 'start' });
    const result = await handler('s', { action: 'stop' });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('stopped');
    expect(mockCallServiceExtension).toHaveBeenCalledWith(
      'inspector.trackRebuildDirtyWidgets',
      { enabled: 'false' },
    );
    expect(mockOffEvent).toHaveBeenCalledWith('Extension', expect.any(Function));
  });

  it('stop without active tracker returns noop', async () => {
    const result = await handler('s', { action: 'stop' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('noop');
    expect(mockCallServiceExtension).not.toHaveBeenCalled();
    expect(mockOffEvent).not.toHaveBeenCalled();
  });

  it('start with duration_ms arms auto-stop that clears the tracker', async () => {
    jest.useFakeTimers();
    try {
      await handler('s', { action: 'start', duration_ms: 100 });
      jest.advanceTimersByTime(100);
      // Flush pending microtasks from the async auto-stop
      await Promise.resolve();
      await Promise.resolve();
      const second = await handler('s', { action: 'report' });
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toContain('No active tracker');
    } finally {
      jest.useRealTimers();
    }
  });

  it('errors when action is unknown with a helpful message', async () => {
    const result = await handler('s', { action: 'purge' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('action must be one of');
    expect(result.content[0].text).toContain('purge');
  });

  it('errors when action is missing', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('action is required');
  });

  it('start rolls back listener registration if enabling the extension fails (P1 listener-leak regression)', async () => {
    mockCallServiceExtension.mockRejectedValueOnce(new Error('extension not registered'));

    const result = await handler('s', { action: 'start' });
    expect(result.isError).toBe(true);

    // offEvent must have been called to undo the listener registration.
    expect(mockOffEvent).toHaveBeenCalledWith('Extension', expect.any(Function));

    // And no tracker entry should have been persisted — a follow-up start must succeed.
    mockCallServiceExtension.mockResolvedValueOnce({});
    const retry = await handler('s', { action: 'start' });
    const body = JSON.parse(retry.content[0].text);
    expect(body.status).toBe('started');
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { action: 'start' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
  });
});

export {};
