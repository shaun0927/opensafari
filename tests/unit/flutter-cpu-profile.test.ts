/**
 * Unit tests for flutter_cpu_profile + flutter_timeline_capture (issue #439).
 */

import {
  aggregateCpuSamples,
  validateTimelineStreams,
} from '../../src/tools/flutter-cpu-profile';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockCallMethod = jest.fn();
const mockGetState = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    callMethod: mockCallMethod,
    getState: mockGetState,
  }),
  FlutterVMError: class extends Error {
    constructor(msg: string, public readonly code: string) { super(msg); }
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── aggregateCpuSamples ─────────────────────────────────────────────────────

describe('aggregateCpuSamples', () => {
  const payload = {
    samplePeriod: 1000, // 1000us per sample
    functions: [
      { function: { name: 'main' }, resolvedUrl: 'package:app/main.dart' },
      { function: { name: 'build' }, resolvedUrl: 'package:flutter/src/widgets/framework.dart' },
      { function: { name: 'paint' } },
    ],
    samples: [
      { stack: [1, 0] },        // build (top), main
      { stack: [2, 1, 0] },     // paint (top), build, main
      { stack: [1, 0] },        // build (top), main
      { stack: [0] },           // main (top)
    ],
  };

  it('counts self and total samples per function', () => {
    const stats = aggregateCpuSamples(payload);

    const main = stats.find((s) => s.function === 'main')!;
    const build = stats.find((s) => s.function === 'build')!;
    const paint = stats.find((s) => s.function === 'paint')!;

    // self: main at top once; build at top twice; paint at top once
    expect(main.self_samples).toBe(1);
    expect(build.self_samples).toBe(2);
    expect(paint.self_samples).toBe(1);

    // total: main appears in all 4 stacks; build in 3; paint in 1
    expect(main.total_samples).toBe(4);
    expect(build.total_samples).toBe(3);
    expect(paint.total_samples).toBe(1);
  });

  it('converts sample counts to microseconds via samplePeriod', () => {
    const stats = aggregateCpuSamples(payload);
    const build = stats.find((s) => s.function === 'build')!;
    expect(build.self_us).toBe(2 * 1000);
    expect(build.total_us).toBe(3 * 1000);
  });

  it('sorts descending by self_us', () => {
    const stats = aggregateCpuSamples(payload);
    expect(stats[0].function).toBe('build');
    expect(stats[0].self_us).toBeGreaterThanOrEqual(stats[1].self_us);
  });

  it('drops functions that never appear in any sample', () => {
    const stats = aggregateCpuSamples({
      samplePeriod: 1,
      functions: [
        { function: { name: 'used' } },
        { function: { name: 'never-called' } },
      ],
      samples: [{ stack: [0] }],
    });
    expect(stats.map((s) => s.function)).toEqual(['used']);
  });

  it('tolerates malformed samples', () => {
    const stats = aggregateCpuSamples({
      samplePeriod: 1,
      functions: [{ function: { name: 'ok' } }],
      samples: [{}, { stack: 'oops' } as unknown as { stack: number[] }, { stack: [0] }],
    });
    expect(stats[0].function).toBe('ok');
    expect(stats[0].self_samples).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(aggregateCpuSamples({})).toEqual([]);
  });

  it('falls back to samplePeriod=1 when missing', () => {
    const stats = aggregateCpuSamples({
      functions: [{ function: { name: 'a' } }],
      samples: [{ stack: [0] }],
    });
    expect(stats[0].self_us).toBe(1);
  });
});

// ── validateTimelineStreams ─────────────────────────────────────────────────

describe('validateTimelineStreams', () => {
  it('returns defaults when undefined', () => {
    expect(validateTimelineStreams(undefined)).toEqual(['Dart', 'GC', 'Embedder']);
  });

  it('accepts the default set', () => {
    expect(validateTimelineStreams(['Dart', 'GC'])).toEqual(['Dart', 'GC']);
  });

  it('dedupes', () => {
    expect(validateTimelineStreams(['Dart', 'Dart', 'GC'])).toEqual(['Dart', 'GC']);
  });

  it('rejects non-array', () => {
    expect(() => validateTimelineStreams('Dart')).toThrow('array of strings');
  });

  it('rejects non-string element', () => {
    expect(() => validateTimelineStreams(['Dart', 42])).toThrow('array of strings');
  });

  it('rejects unknown stream', () => {
    expect(() => validateTimelineStreams(['NotAStream'])).toThrow('unknown timeline stream');
  });
});

// ── flutter_cpu_profile handler ─────────────────────────────────────────────

describe('flutter_cpu_profile handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterCpuProfileTool } = require('../../src/tools/flutter-cpu-profile');
    registerFlutterCpuProfileTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('rejects missing duration_ms', async () => {
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('duration_ms must be a positive number');
  });

  it('rejects duration_ms above the 120s cap', async () => {
    const result = await handler('s', { duration_ms: 200_000 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be <=');
  });

  it('forwards isolate and time window to getCpuSamples', async () => {
    mockCallMethod.mockResolvedValue({
      samplePeriod: 1000,
      functions: [{ function: { name: 'main' } }],
      samples: [{ stack: [0] }],
    });

    const result = await handler('s', { duration_ms: 10 });
    const body = JSON.parse(result.content[0].text);

    expect(mockCallMethod).toHaveBeenCalledWith('getCpuSamples', expect.objectContaining({
      isolateId: 'iso-1',
      timeExtentMicros: 10_000,
    }));
    expect(body.status).toBe('ok');
    expect(body.top_functions[0].function).toBe('main');
    expect(body.sample_count).toBe(1);
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { duration_ms: 10 });
    expect(result.isError).toBe(true);
  });
});

// ── flutter_timeline_capture handler ────────────────────────────────────────

describe('flutter_timeline_capture handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterTimelineCaptureTool } = require('../../src/tools/flutter-cpu-profile');
    registerFlutterTimelineCaptureTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetState.mockReturnValue({ mainIsolateId: 'iso-1' });
  });

  it('rejects missing required fields', async () => {
    const r1 = await handler('s', {});
    expect(r1.isError).toBe(true);
    const r2 = await handler('s', { duration_ms: 10 });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain('output_path');
  });

  it('sets timeline streams, waits, fetches timeline, writes file', async () => {
    mockCallMethod.mockImplementation(async (method: string) => {
      if (method === 'setVMTimelineFlags') return {};
      if (method === 'getVMTimeline') {
        return { traceEvents: [{ name: 'frame', ph: 'X', pid: 1, tid: 2, ts: 100, dur: 500 }] };
      }
      return {};
    });

    const outPath = path.join(os.tmpdir(), `opensafari-timeline-${Date.now()}.json`);
    try {
      const result = await handler('s', { duration_ms: 10, output_path: outPath });
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);

      expect(body.status).toBe('ok');
      expect(body.event_count).toBe(1);
      expect(body.streams).toEqual(['Dart', 'GC', 'Embedder']);

      // Verify setVMTimelineFlags got the defaults.
      const setCall = mockCallMethod.mock.calls.find((c) => c[0] === 'setVMTimelineFlags');
      expect(setCall?.[1]).toEqual({ recordedStreams: ['Dart', 'GC', 'Embedder'] });

      // Verify file written with Chrome Trace shape.
      const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
      expect(Array.isArray(written.traceEvents)).toBe(true);
      expect(written.traceEvents[0].name).toBe('frame');
      expect(written.displayTimeUnit).toBe('ms');
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  });

  it('forwards custom streams', async () => {
    mockCallMethod.mockResolvedValue({ traceEvents: [] });
    const outPath = path.join(os.tmpdir(), `opensafari-timeline-${Date.now()}-custom.json`);
    try {
      await handler('s', { duration_ms: 10, output_path: outPath, streams: ['Dart', 'Compiler'] });
      const setCall = mockCallMethod.mock.calls.find((c) => c[0] === 'setVMTimelineFlags');
      expect(setCall?.[1]).toEqual({ recordedStreams: ['Dart', 'Compiler'] });
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  });

  it('rejects unknown stream name without touching the VM', async () => {
    const result = await handler('s', {
      duration_ms: 10,
      output_path: '/tmp/should-not-write.json',
      streams: ['NotReal'],
    });
    expect(result.isError).toBe(true);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { duration_ms: 10, output_path: '/tmp/x.json' });
    expect(result.isError).toBe(true);
  });

  it('resets timeline flags when writeFile fails (P1 regression)', async () => {
    const unwritable = '/proc/0/should-not-work/trace.json';

    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    mockCallMethod.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'getVMTimeline') return { traceEvents: [] };
      return {};
    });

    const result = await handler('s', { duration_ms: 10, output_path: unwritable });
    expect(result.isError).toBe(true);

    // setVMTimelineFlags must have been called twice: once to enable, once to reset.
    const setCalls = calls.filter((c) => c.method === 'setVMTimelineFlags');
    expect(setCalls.length).toBe(2);
    expect(setCalls[0].params).toEqual({ recordedStreams: ['Dart', 'GC', 'Embedder'] });
    expect(setCalls[1].params).toEqual({ recordedStreams: [] });
  });
});
