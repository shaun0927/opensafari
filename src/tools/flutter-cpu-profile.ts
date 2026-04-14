/**
 * flutter_cpu_profile + flutter_timeline_capture (issue #439).
 *
 * Two MCP tools for performance investigation:
 *
 *   - flutter_cpu_profile: samples the Dart VM's CPU profiler for a time
 *     window via getCpuSamples, aggregates per-function self_us / total_us,
 *     returns a top-N list ready for LLM reading.
 *
 *   - flutter_timeline_capture: enables the requested timeline streams,
 *     waits a window, reads getVMTimeline, and writes the result to disk
 *     as Chrome Trace Event JSON loadable in chrome://tracing or Perfetto.
 *
 * Profile builds give the most accurate results (debug has overhead that
 * skews the flamegraph). Both tools require an active flutter_connect
 * session and are deliberately gated to reasonable durations.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { getFlutterVMClient, FlutterVMError } from '../flutter';
import { getSessionManager } from '../session-manager';

const MAX_DURATION_MS = 120_000; // 2 minutes — longer windows balloon response size

async function resolveClient(paramDeviceId: unknown) {
  const deviceId =
    (typeof paramDeviceId === 'string' ? paramDeviceId : undefined) ??
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw new Error('No device specified and no active device. Boot a simulator first.');
  }
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
  }
  return { deviceId, client };
}

function validateDuration(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error('duration_ms must be a positive number');
  }
  if (raw > MAX_DURATION_MS) {
    throw new Error(`duration_ms must be <= ${MAX_DURATION_MS} (got ${raw})`);
  }
  return Math.floor(raw);
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

// ── CPU profile aggregation ─────────────────────────────────────────────────

export interface FunctionStat {
  function: string;
  resolved_url?: string;
  self_us: number;
  total_us: number;
  self_samples: number;
  total_samples: number;
}

interface CpuSamplesPayload {
  samples?: Array<{
    stack?: number[];
    tid?: number;
    timestamp?: number;
  }>;
  functions?: Array<{
    function?: { name?: string; type?: string };
    resolvedUrl?: string;
    kind?: string;
    [k: string]: unknown;
  }>;
  samplePeriod?: number; // microseconds per sample
  timeSpan?: number;
  [k: string]: unknown;
}

/**
 * Aggregate a `getCpuSamples` payload into a per-function statistics map.
 * `self_us` counts only samples where the function appears at the top of
 * the stack; `total_us` counts samples where it appears anywhere. Both
 * are expressed in microseconds using the payload's `samplePeriod`.
 */
export function aggregateCpuSamples(payload: CpuSamplesPayload): FunctionStat[] {
  const functions = Array.isArray(payload.functions) ? payload.functions : [];
  const samples = Array.isArray(payload.samples) ? payload.samples : [];
  const samplePeriod = typeof payload.samplePeriod === 'number' && payload.samplePeriod > 0
    ? payload.samplePeriod
    : 1; // fallback: treat each sample as 1us so ratios are still meaningful

  const selfCounts = new Map<number, number>();
  const totalCounts = new Map<number, number>();

  for (const sample of samples) {
    const stack = Array.isArray(sample.stack) ? sample.stack : [];
    if (stack.length === 0) continue;
    const top = stack[0];
    if (typeof top === 'number') {
      selfCounts.set(top, (selfCounts.get(top) ?? 0) + 1);
    }
    const unique = new Set<number>();
    for (const fn of stack) {
      if (typeof fn === 'number') unique.add(fn);
    }
    for (const fn of unique) {
      totalCounts.set(fn, (totalCounts.get(fn) ?? 0) + 1);
    }
  }

  const stats: FunctionStat[] = [];
  for (let i = 0; i < functions.length; i += 1) {
    const entry = functions[i];
    if (!entry) continue;
    const selfSamples = selfCounts.get(i) ?? 0;
    const totalSamples = totalCounts.get(i) ?? 0;
    if (selfSamples === 0 && totalSamples === 0) continue;
    stats.push({
      function: entry.function?.name ?? `fn#${i}`,
      resolved_url: typeof entry.resolvedUrl === 'string' ? entry.resolvedUrl : undefined,
      self_us: selfSamples * samplePeriod,
      total_us: totalSamples * samplePeriod,
      self_samples: selfSamples,
      total_samples: totalSamples,
    });
  }

  stats.sort((a, b) => b.self_us - a.self_us);
  return stats;
}

export function registerFlutterCpuProfileTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_cpu_profile',
      description:
        'Sample the Dart VM CPU profiler for a time window and return a ' +
        'top-N list of {function, self_us, total_us, samples}. Wraps ' +
        'getCpuSamples. Profile builds produce the most accurate data; ' +
        'debug builds work but include framework overhead. Max duration 120s.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Sampling window in milliseconds (max 120000).',
          },
          top_n: {
            type: 'number',
            description: 'Maximum rows to return sorted by self_us (default: 20).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['duration_ms'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const durationMs = validateDuration(params.duration_ms);
        const topN = typeof params.top_n === 'number' && params.top_n > 0
          ? Math.min(Math.floor(params.top_n), 500)
          : 20;

        const { deviceId, client } = await resolveClient(params.device_id);
        const isolateId = client.getState()?.mainIsolateId;
        if (!isolateId) throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');

        const startMicros = Date.now() * 1000;
        await sleep(durationMs);
        const extentMicros = durationMs * 1000;

        const raw = await client.callMethod('getCpuSamples', {
          isolateId,
          timeOriginMicros: startMicros,
          timeExtentMicros: extentMicros,
        });
        const stats = aggregateCpuSamples(raw as CpuSamplesPayload);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              duration_ms: durationMs,
              sample_count: Array.isArray((raw as CpuSamplesPayload).samples)
                ? ((raw as CpuSamplesPayload).samples as unknown[]).length
                : 0,
              total_functions: stats.length,
              top_functions: stats.slice(0, topN),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_cpu_profile] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

// ── Timeline capture ────────────────────────────────────────────────────────

const DEFAULT_TIMELINE_STREAMS = ['Dart', 'GC', 'Embedder'] as const;
const ALLOWED_TIMELINE_STREAMS = new Set([
  'Dart', 'GC', 'Embedder', 'Compiler', 'CompilerVerbose', 'Debugger',
  'Isolate', 'VM', 'API', 'Microtask',
]);

export function validateTimelineStreams(raw: unknown): string[] {
  if (raw === undefined) return [...DEFAULT_TIMELINE_STREAMS];
  if (!Array.isArray(raw)) {
    throw new Error('streams must be an array of strings');
  }
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s !== 'string') throw new Error('streams must be an array of strings');
    if (!ALLOWED_TIMELINE_STREAMS.has(s)) {
      throw new Error(`unknown timeline stream "${s}" (allowed: ${[...ALLOWED_TIMELINE_STREAMS].join(', ')})`);
    }
    seen.add(s);
  }
  return [...seen];
}

export function registerFlutterTimelineCaptureTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_timeline_capture',
      description:
        'Enable VM timeline streams for a window, then export the captured ' +
        'events as Chrome Trace JSON (loadable in chrome://tracing or Perfetto). ' +
        'Default streams are Dart + GC + Embedder; pass "streams" to override. ' +
        'Output is written to output_path so large traces do not balloon the MCP response. ' +
        'Max duration 120s.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Capture window in milliseconds (max 120000).',
          },
          output_path: {
            type: 'string',
            description: 'File path to write the Chrome Trace JSON output.',
          },
          streams: {
            type: 'array',
            items: { type: 'string' },
            description: 'Timeline streams to record. Default: ["Dart", "GC", "Embedder"].',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['duration_ms', 'output_path'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const durationMs = validateDuration(params.duration_ms);
        const outputPath = params.output_path;
        if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
          throw new Error('output_path is required (non-empty string)');
        }
        const streams = validateTimelineStreams(params.streams);

        const { deviceId, client } = await resolveClient(params.device_id);

        await client.callMethod('setVMTimelineFlags', { recordedStreams: streams });

        const started = Date.now();

        // Anything past this point must restore timeline flags before returning —
        // a disk-full / permission-denied / RPC failure after enabling would
        // otherwise leave the VM recording streams indefinitely, growing its
        // internal timeline buffer and skewing every subsequent capture.
        try {
          await sleep(durationMs);

          const raw = await client.callMethod('getVMTimeline');
          const traceEvents = (raw as { traceEvents?: unknown[] }).traceEvents ?? [];

          // Chrome Trace Format: top-level object with traceEvents array.
          const chromeTrace = JSON.stringify({ traceEvents, displayTimeUnit: 'ms' });

          const absolute = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, chromeTrace, 'utf8');

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'ok',
                deviceId,
                duration_ms: durationMs,
                streams,
                output_path: absolute,
                size_bytes: Buffer.byteLength(chromeTrace, 'utf8'),
                event_count: Array.isArray(traceEvents) ? traceEvents.length : 0,
                elapsed_ms: Date.now() - started,
                hint: 'Open this file in chrome://tracing or import into Perfetto.',
              }, null, 2),
            }],
          };
        } finally {
          try {
            await client.callMethod('setVMTimelineFlags', { recordedStreams: [] });
          } catch (resetErr) {
            console.error(`[flutter_timeline_capture] failed to reset timeline flags: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_timeline_capture] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
