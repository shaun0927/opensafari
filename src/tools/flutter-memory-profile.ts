/**
 * flutter_allocation_profile + flutter_heap_snapshot (issue #440).
 *
 * Two MCP tools that expose the Dart VM memory-profiling RPCs:
 *
 *   - flutter_allocation_profile: class-level instance / byte counters,
 *     optionally diffed against the previous call on the same device.
 *   - flutter_heap_snapshot: triggers a heap snapshot and streams the
 *     resulting chunks to a binary file that can be loaded into
 *     Flutter DevTools' Memory tab.
 *
 * Debug/profile builds only (release builds disable the VM Service).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';
import { MCPServer } from '../mcp-server';
import { getFlutterVMClient, FlutterVMError } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';

// ── Shared helpers ──────────────────────────────────────────────────────────

async function resolveClient(paramDeviceId: unknown) {
  const deviceId =
    (typeof paramDeviceId === 'string' ? paramDeviceId : undefined) ??
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first.');
  }
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    throw StructuredErrorException.fromCode(ErrorCode.FLUTTER_VM_NOT_CONNECTED, 'Not connected to Flutter VM Service. Run flutter_connect first.');
  }
  return { deviceId, client };
}

// ── Allocation profile ──────────────────────────────────────────────────────

export interface AllocationEntry {
  class: string;
  instances_current: number;
  bytes_current: number;
  accumulated_instances?: number;
  accumulated_size?: number;
  /** Populated when diff mode is active */
  delta_instances?: number;
  delta_bytes?: number;
}

interface AllocationSnapshot {
  takenAt: number;
  entries: Map<string, AllocationEntry>;
}

/**
 * Per-device diff baselines. Bounded to MAX_DEVICES entries via LRU
 * eviction so that long-lived sessions with rotating simulator UDIDs
 * cannot leak memory. When a caller is done with a device they should
 * also call `forgetAllocationHistory(deviceId)` explicitly.
 */
const MAX_DEVICES = 16;
const previousSnapshots = new Map<string, AllocationSnapshot>();

function rememberSnapshot(deviceId: string, snapshot: AllocationSnapshot): void {
  // Re-insert to refresh LRU position.
  if (previousSnapshots.has(deviceId)) previousSnapshots.delete(deviceId);
  previousSnapshots.set(deviceId, snapshot);

  while (previousSnapshots.size > MAX_DEVICES) {
    const oldestKey = previousSnapshots.keys().next().value;
    if (oldestKey === undefined) break;
    previousSnapshots.delete(oldestKey);
  }
}

export function _resetAllocationHistory(): void {
  previousSnapshots.clear();
}

/** Public: drop the diff baseline for a specific device (e.g. on disconnect). */
export function forgetAllocationHistory(deviceId: string): void {
  previousSnapshots.delete(deviceId);
}

/** Normalise a raw `AllocationProfile` response into the flat shape we expose. */
export function parseAllocationProfile(raw: unknown): AllocationEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const members = (raw as { members?: unknown }).members;
  if (!Array.isArray(members)) return [];

  return members
    .map((m): AllocationEntry | null => {
      if (!m || typeof m !== 'object') return null;
      const member = m as Record<string, unknown>;
      const cls = (member.class as { name?: string } | undefined)?.name
        ?? (typeof member.classRef === 'object' && member.classRef !== null
          ? (member.classRef as { name?: string }).name
          : undefined)
        ?? 'unknown';

      const instancesCurrent = Number(member.instancesCurrent ?? 0);
      const bytesCurrent = Number(member.bytesCurrent ?? 0);
      const accumulatedInstances = Number(member.instancesAccumulated ?? 0);
      const accumulatedSize = Number(member.accumulatedSize ?? 0);

      if (!Number.isFinite(instancesCurrent) || !Number.isFinite(bytesCurrent)) return null;
      // Drop empty rows entirely — the raw response lists every class in the VM,
      // including ones with zero live instances.
      if (instancesCurrent === 0 && bytesCurrent === 0) return null;

      return {
        class: cls,
        instances_current: instancesCurrent,
        bytes_current: bytesCurrent,
        accumulated_instances: accumulatedInstances || undefined,
        accumulated_size: accumulatedSize || undefined,
      };
    })
    .filter((e): e is AllocationEntry => e !== null);
}

export function diffAllocationEntries(
  current: AllocationEntry[],
  previous: Map<string, AllocationEntry>,
): AllocationEntry[] {
  return current.map((entry) => {
    const prev = previous.get(entry.class);
    if (!prev) return { ...entry, delta_instances: entry.instances_current, delta_bytes: entry.bytes_current };
    return {
      ...entry,
      delta_instances: entry.instances_current - prev.instances_current,
      delta_bytes: entry.bytes_current - prev.bytes_current,
    };
  });
}

export function registerFlutterAllocationProfileTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_allocation_profile',
      description:
        'Capture a per-class allocation profile of the running Flutter app ' +
        '(wraps VM Service getAllocationProfile). Use gc_before=true to force a ' +
        'major GC before sampling (recommended for leak detection). ' +
        'Use diff_against_previous=true to return deltas vs the previous call on ' +
        'the same device — the typical leak-hunt pattern is: baseline → action → ' +
        'diff. Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          gc_before: {
            type: 'boolean',
            description: 'Force a major GC before capturing (default: false).',
          },
          top_n: {
            type: 'number',
            description: 'Maximum rows to return, sorted by bytes_current or abs(delta_bytes) in diff mode (default: 25).',
          },
          diff_against_previous: {
            type: 'boolean',
            description: 'Return delta_instances / delta_bytes vs the previous call on this device.',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const { deviceId, client } = await resolveClient(params.device_id);

        const isolateId = client.getState()?.mainIsolateId;
        if (!isolateId) throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');

        const rpcParams: Record<string, unknown> = { isolateId };
        if (params.gc_before === true) rpcParams.gc = true;

        const raw = await client.callMethod('getAllocationProfile', rpcParams);
        const entries = parseAllocationProfile(raw);

        const topN = typeof params.top_n === 'number' && params.top_n > 0
          ? Math.min(Math.floor(params.top_n), 1000)
          : 25;

        const diff = params.diff_against_previous === true;
        let shaped: AllocationEntry[] = entries;
        let previousTakenAt: number | undefined;

        if (diff) {
          const prev = previousSnapshots.get(deviceId);
          if (prev) {
            shaped = diffAllocationEntries(entries, prev.entries);
            previousTakenAt = prev.takenAt;
          } else {
            shaped = entries.map((e) => ({ ...e, delta_instances: e.instances_current, delta_bytes: e.bytes_current }));
          }
        }

        // Store the current snapshot unconditionally so a later diff has a
        // baseline. rememberSnapshot enforces the MAX_DEVICES LRU cap so the
        // Map cannot grow without bound across long-running sessions.
        const asMap = new Map<string, AllocationEntry>();
        for (const e of entries) asMap.set(e.class, e);
        rememberSnapshot(deviceId, { takenAt: Date.now(), entries: asMap });

        shaped.sort((a, b) =>
          diff
            ? Math.abs(b.delta_bytes ?? 0) - Math.abs(a.delta_bytes ?? 0)
            : b.bytes_current - a.bytes_current,
        );
        const top = shaped.slice(0, topN);

        const memoryUsage = (raw as { memoryUsage?: Record<string, unknown> }).memoryUsage;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              mode: diff ? 'diff' : 'snapshot',
              gc_before: params.gc_before === true,
              previous_taken_at: previousTakenAt,
              taken_at: Date.now(),
              memory_usage: memoryUsage,
              entries: top,
              total_classes: entries.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_allocation_profile] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message);
      }
    },
  );
}

// ── Heap snapshot ───────────────────────────────────────────────────────────

interface SnapshotChunk {
  bytes?: string;
  isLast?: boolean;
  [key: string]: unknown;
}

/**
 * Drain `HeapSnapshot` events until an `isLast` chunk arrives.
 * Exposed for testing — the handler uses it internally.
 */
type HeapSnapshotListener = (ev: unknown) => void;

export function collectHeapSnapshot(
  client: {
    onEvent: (streamId: string, cb: HeapSnapshotListener) => void;
    offEvent: (streamId: string, cb: HeapSnapshotListener) => void;
    streamListen: (streamId: string) => Promise<void>;
    callMethod: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getState: () => { mainIsolateId?: string } | null;
  },
  opts: { timeoutMs?: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let settled = false;
  let resolvePromise!: (buffer: Buffer) => void;
  let rejectPromise!: (err: Error) => void;

  const promise = new Promise<Buffer>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const listener: HeapSnapshotListener = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const chunk = ev as SnapshotChunk & { kind?: string };
    if (chunk.kind !== 'HeapSnapshot') return;
    if (typeof chunk.bytes === 'string' && chunk.bytes.length > 0) {
      chunks.push(Buffer.from(chunk.bytes, 'base64'));
    }
    if (chunk.isLast && !settled) {
      settled = true;
      client.offEvent('HeapSnapshot', listener);
      resolvePromise(Buffer.concat(chunks));
    }
  };

  // Register the listener SYNCHRONOUSLY so tests and real callers can
  // drive it without racing the streamListen / requestHeapSnapshot awaits.
  client.onEvent('HeapSnapshot', listener);

  void (async () => {
    try {
      await client.streamListen('HeapSnapshot');
      const isolateId = client.getState()?.mainIsolateId;
      if (!isolateId) throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');
      await client.callMethod('requestHeapSnapshot', { isolateId });
    } catch (err) {
      if (!settled) {
        settled = true;
        client.offEvent('HeapSnapshot', listener);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.offEvent('HeapSnapshot', listener);
    rejectPromise(new FlutterVMError(`Heap snapshot timed out after ${timeoutMs}ms`, 'SNAPSHOT_TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();

  return promise.finally(() => clearTimeout(timer));
}

export function registerFlutterHeapSnapshotTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_heap_snapshot',
      description:
        'Capture a full Dart heap snapshot from the running Flutter app and ' +
        'write it to a binary file importable in the Flutter DevTools Memory ' +
        'tab. The VM is briefly paused while snapshotting; for large heaps this ' +
        'may take several seconds. Requires an active flutter_connect session ' +
        '(debug / profile builds).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          output_path: {
            type: 'string',
            description: 'Absolute or working-dir-relative file path to write the snapshot to.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Maximum wait in ms for snapshot completion (default: 60000).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['output_path'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const outputPath = params.output_path;
        if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
          throw new Error('output_path is required (non-empty string)');
        }

        const { deviceId, client } = await resolveClient(params.device_id);

        const timeoutMs = typeof params.timeout_ms === 'number' && params.timeout_ms > 0
          ? Math.min(Math.floor(params.timeout_ms), 600_000)
          : 60_000;

        const started = Date.now();
        const buffer = await collectHeapSnapshot(
          {
            onEvent: client.onEvent.bind(client),
            offEvent: client.offEvent.bind(client),
            streamListen: client.streamListen.bind(client),
            callMethod: client.callMethod.bind(client),
            getState: client.getState.bind(client),
          },
          { timeoutMs },
        );

        // Ensure parent directory exists (best effort; a simulator tool running
        // inside the project may pass a path under ./tmp that does not exist yet).
        const absolute = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, buffer);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              output_path: absolute,
              size_bytes: buffer.byteLength,
              elapsed_ms: Date.now() - started,
              hint: 'Open this file in Flutter DevTools → Memory tab → "Load snapshot".',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_heap_snapshot] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message);
      }
    },
  );
}
