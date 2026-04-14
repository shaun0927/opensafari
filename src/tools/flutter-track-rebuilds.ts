/**
 * flutter_track_rebuilds — Start, stop, and report widget rebuild counts.
 *
 * Motivation (issue #438): unnecessary widget rebuilds are a top cause
 * of Flutter performance regressions and are invisible from screenshots
 * alone. The Flutter framework already tracks dirty-widget rebuilds when
 * asked via `ext.flutter.inspector.trackRebuildDirtyWidgets(true)` and
 * publishes `Flutter.RebuildWidgets` events on the `Extension` stream.
 *
 * This tool wraps the full lifecycle (start → events accumulate →
 * report or stop → disable tracking) behind a single MCP tool so LLMs
 * can run deterministic rebuild audits without managing stream state.
 *
 * Requires an active flutter_connect session (debug builds; the
 * tracking extension is only registered when assertions are on).
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import type { VMServiceEvent } from '../flutter/flutter-types';

// ── Per-device tracking state ───────────────────────────────────────────────

type FlutterEvent = VMServiceEvent['params']['event'];

export interface LocationInfo {
  id: number;
  file: string;
  line?: number;
  column?: number;
  name?: string;
}

export interface TrackerState {
  deviceId: string;
  startedAt: number;
  autoStopTimer?: NodeJS.Timeout;
  subscribed: boolean;
  /** locationId → rebuild count (summed across all events) */
  counts: Map<number, number>;
  /** locationId → source location + widget name */
  locations: Map<number, LocationInfo>;
  /** Per-event bookkeeping for leak / overflow guard */
  eventCount: number;
  listener: (ev: FlutterEvent) => void;
}

const MAX_EVENTS_PER_TRACKER = 10_000;

const trackers = new Map<string, TrackerState>();

/** Visible for testing. */
export function _resetTrackers(): void {
  for (const tracker of trackers.values()) {
    if (tracker.autoStopTimer) clearTimeout(tracker.autoStopTimer);
  }
  trackers.clear();
}

// ── Event parsing ───────────────────────────────────────────────────────────

/**
 * Shape of a Flutter.RebuildWidgets event payload. Events come encoded as a
 * flat `[locationId, count, locationId, count, ...]` array in recent Flutter
 * versions, or as `[[locId, count], ...]` pairs in older ones — we handle both.
 * Locations are a compact map of id → {file, line, column, name} where name
 * is the widget runtime type.
 */
interface RebuildEventPayload {
  startTime?: number;
  events?: unknown;
  locations?: Record<string, unknown>;
}

export function mergeRebuildEvent(state: TrackerState, raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const payload = raw as RebuildEventPayload;
  let added = 0;

  // Locations: { "1": {file, line, column, name}, ... }
  if (payload.locations && typeof payload.locations === 'object') {
    for (const [idStr, locRaw] of Object.entries(payload.locations)) {
      if (!locRaw || typeof locRaw !== 'object') continue;
      const loc = locRaw as Record<string, unknown>;
      const id = Number(idStr);
      if (Number.isNaN(id)) continue;
      if (!state.locations.has(id)) {
        state.locations.set(id, {
          id,
          file: typeof loc.file === 'string' ? loc.file : 'unknown',
          line: typeof loc.line === 'number' ? loc.line : undefined,
          column: typeof loc.column === 'number' ? loc.column : undefined,
          name: typeof loc.name === 'string' ? loc.name : undefined,
        });
      }
    }
  }

  const events = payload.events;
  if (Array.isArray(events)) {
    // Flat pairs: [locId, count, locId, count, ...]
    if (events.length > 0 && typeof events[0] === 'number') {
      for (let i = 0; i + 1 < events.length; i += 2) {
        const locId = events[i] as number;
        const count = events[i + 1] as number;
        if (typeof locId !== 'number' || typeof count !== 'number') continue;
        state.counts.set(locId, (state.counts.get(locId) ?? 0) + count);
        added += count;
      }
    } else {
      // Nested pairs: [[locId, count], ...]
      for (const entry of events) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [locId, count] = entry as [unknown, unknown];
        if (typeof locId !== 'number' || typeof count !== 'number') continue;
        state.counts.set(locId, (state.counts.get(locId) ?? 0) + count);
        added += count;
      }
    }
  }

  state.eventCount += 1;
  return added;
}

// ── Lifecycle helpers (exported for testability) ────────────────────────────

async function startTracking(
  deviceId: string,
  autoStopMs: number | undefined,
  onAutoStop: () => Promise<void>,
): Promise<TrackerState> {
  if (trackers.has(deviceId)) {
    throw new Error(`Tracking is already active for device ${deviceId}. Call action="stop" or action="report" first.`);
  }

  const client = getFlutterVMClient(deviceId);

  const state: TrackerState = {
    deviceId,
    startedAt: Date.now(),
    subscribed: false,
    counts: new Map(),
    locations: new Map(),
    eventCount: 0,
    listener: () => {},
  };

  state.listener = (ev: FlutterEvent) => {
    const extensionKind = (ev as unknown as Record<string, unknown>).extensionKind;
    if (extensionKind !== 'Flutter.RebuildWidgets') return;
    if (state.eventCount >= MAX_EVENTS_PER_TRACKER) return;
    mergeRebuildEvent(state, (ev as unknown as Record<string, unknown>).extensionData);
  };

  // Subscribe + enable in a single transactional unit. If any step fails
  // we roll back so no listener is left registered against a client that
  // the caller no longer thinks is tracking (code-review P1).
  await client.streamListen('Extension');
  client.onEvent('Extension', state.listener);
  state.subscribed = true;

  try {
    await client.callServiceExtension('inspector.trackRebuildDirtyWidgets', {
      enabled: 'true',
    });
  } catch (err) {
    client.offEvent('Extension', state.listener);
    state.subscribed = false;
    throw err;
  }

  trackers.set(deviceId, state);

  if (autoStopMs && autoStopMs > 0) {
    state.autoStopTimer = setTimeout(() => {
      onAutoStop().catch((err) => {
        console.error(`[flutter_track_rebuilds] auto-stop failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, autoStopMs);
  }

  return state;
}

async function stopTracking(deviceId: string): Promise<TrackerState | null> {
  const state = trackers.get(deviceId);
  if (!state) return null;

  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer);
    state.autoStopTimer = undefined;
  }

  const client = getFlutterVMClient(deviceId);
  // Best-effort disable — if the extension rejects, we still remove the tracker
  // so the user is not stuck in an "already active" state.
  try {
    await client.callServiceExtension('inspector.trackRebuildDirtyWidgets', {
      enabled: 'false',
    });
  } catch (err) {
    console.error(`[flutter_track_rebuilds] disable extension failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (state.subscribed) {
    client.offEvent('Extension', state.listener);
    state.subscribed = false;
  }

  trackers.delete(deviceId);
  return state;
}

export function buildReport(state: TrackerState, topN: number): Record<string, unknown> {
  const entries = [...state.counts.entries()]
    .map(([locId, count]) => {
      const loc = state.locations.get(locId);
      return {
        widget: loc?.name ?? `loc#${locId}`,
        file: loc?.file ?? 'unknown',
        line: loc?.line,
        column: loc?.column,
        rebuild_count: count,
      };
    })
    .sort((a, b) => b.rebuild_count - a.rebuild_count)
    .slice(0, topN);

  return {
    started_at: state.startedAt,
    elapsed_ms: Date.now() - state.startedAt,
    event_count: state.eventCount,
    total_rebuilds: [...state.counts.values()].reduce((acc, n) => acc + n, 0),
    capped: state.eventCount >= MAX_EVENTS_PER_TRACKER,
    entries,
  };
}

// ── Tool registration ───────────────────────────────────────────────────────

type Action = 'start' | 'stop' | 'report';

export function registerFlutterTrackRebuildsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_track_rebuilds',
      description:
        'Track widget rebuild counts in a running Flutter app. ' +
        'action="start" enables ext.flutter.inspector.trackRebuildDirtyWidgets and ' +
        'subscribes to Flutter.RebuildWidgets events; action="report" returns a ' +
        'top-N list of {widget, file:line, rebuild_count}; action="stop" disables ' +
        'tracking and clears state. Use duration_ms on "start" to auto-stop after ' +
        'a fixed window. Requires an active flutter_connect session (debug build).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'report'],
            description: 'Lifecycle action.',
          },
          duration_ms: {
            type: 'number',
            description: 'For action="start": automatically stop after this many ms (optional).',
          },
          top_n: {
            type: 'number',
            description: 'For action="report": maximum entries to include (default: 20).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const action = params.action as Action | undefined;
        if (!action) {
          throw new Error('action is required (one of: start | stop | report)');
        }
        if (!['start', 'stop', 'report'].includes(action)) {
          throw new Error(`action must be one of: start | stop | report (got "${action}")`);
        }

        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device. Boot a simulator first.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        if (action === 'start') {
          const durationMs = typeof params.duration_ms === 'number' && params.duration_ms > 0
            ? params.duration_ms
            : undefined;
          await startTracking(deviceId, durationMs, async () => {
            await stopTracking(deviceId);
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'started',
                deviceId,
                auto_stop_ms: durationMs,
                hint: 'Interact with the app, then call action="report" to read counts.',
              }, null, 2),
            }],
          };
        }

        if (action === 'report') {
          const state = trackers.get(deviceId);
          if (!state) {
            throw new Error('No active tracker. Call action="start" first.');
          }
          const topN = typeof params.top_n === 'number' && params.top_n > 0
            ? Math.floor(params.top_n)
            : 20;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'ok',
                deviceId,
                report: buildReport(state, topN),
              }, null, 2),
            }],
          };
        }

        // action === 'stop'
        const final = await stopTracking(deviceId);
        if (!final) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'noop',
                deviceId,
                hint: 'Tracker was not active.',
              }, null, 2),
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'stopped',
              deviceId,
              report: buildReport(final, 20),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_track_rebuilds] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
