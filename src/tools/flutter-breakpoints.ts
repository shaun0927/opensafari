/**
 * Flutter breakpoint / step debugging (issue #435).
 *
 * Five MCP tools that let an LLM drive the Dart VM Service debugger:
 *
 *   - flutter_set_breakpoint({ script_uri, line })
 *   - flutter_remove_breakpoint({ breakpoint_id })
 *   - flutter_resume({ mode: "continue" | "step_into" | "step_over" | "step_out" })
 *   - flutter_get_stack({ limit? })
 *   - flutter_wait_for_pause({ timeout_ms? })
 *
 * Implementation strategy
 * -----------------------
 * We keep a per-device BreakpointManager that (a) lazily subscribes to
 * the `Debug` event stream the first time any breakpoint-related tool
 * runs for that device, (b) tracks the current pause state, and (c)
 * remembers active breakpoint ids. Tools read/mutate that state; the
 * Debug stream listener updates it from VM events.
 *
 * wait_for_pause polls this state with a bounded interval (matching the
 * app_wait_for / flutter_logs pattern) instead of creating MCP pushes,
 * so the contract stays request/response.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient, FlutterVMError } from '../flutter';
import { getSessionManager } from '../session-manager';
import type { VMServiceEvent } from '../flutter/flutter-types';

type FlutterEvent = VMServiceEvent['params']['event'];

type ResumeMode = 'continue' | 'step_into' | 'step_over' | 'step_out';

// ── Per-device manager ──────────────────────────────────────────────────────

export interface PauseState {
  paused: boolean;
  reason?: string;         // e.g. 'PauseBreakpoint' / 'PauseInterrupted'
  pausedAt?: number;       // Date.now()
  pauseEvent?: FlutterEvent;
}

export interface BreakpointInfo {
  id: string;
  scriptUri: string;
  line: number;
  column?: number;
  resolved: boolean;
}

export interface DeviceBreakpointState {
  deviceId: string;
  subscribed: boolean;
  listener?: (ev: FlutterEvent) => void;
  pause: PauseState;
  breakpoints: Map<string, BreakpointInfo>;
}

const managers = new Map<string, DeviceBreakpointState>();

export function _resetBreakpointManagers(): void {
  managers.clear();
}

function ensureManager(deviceId: string): DeviceBreakpointState {
  let state = managers.get(deviceId);
  if (!state) {
    state = {
      deviceId,
      subscribed: false,
      pause: { paused: false },
      breakpoints: new Map(),
    };
    managers.set(deviceId, state);
  }
  return state;
}

/**
 * Lazily subscribe to the `Debug` event stream on first use. Subsequent
 * calls are no-ops. If the VM stream subscription fails, state.subscribed
 * stays false so we retry next time.
 */
async function ensureDebugSubscription(
  client: {
    streamListen: (streamId: string) => Promise<void>;
    onEvent: (streamId: string, cb: (ev: FlutterEvent) => void) => void;
  },
  state: DeviceBreakpointState,
): Promise<void> {
  if (state.subscribed) return;

  const listener = (ev: FlutterEvent) => {
    const kind = (ev as unknown as Record<string, unknown>).kind;
    if (typeof kind !== 'string') return;
    if (kind === 'PauseBreakpoint' || kind === 'PauseInterrupted' || kind === 'PauseException' || kind === 'PausePostRequest' || kind === 'PauseStart' || kind === 'PauseExit') {
      state.pause = {
        paused: true,
        reason: kind,
        pausedAt: Date.now(),
        pauseEvent: ev,
      };
    } else if (kind === 'Resume') {
      state.pause = { paused: false };
    }
  };

  try {
    await client.streamListen('Debug');
    client.onEvent('Debug', listener);
    state.listener = listener;
    state.subscribed = true;
  } catch (err) {
    // Keep subscribed=false so next call retries.
    throw err;
  }
}

// ── Shared resolveClient helper ─────────────────────────────────────────────

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

function requireIsolateId(client: { getState: () => { mainIsolateId?: string } | null }): string {
  const id = client.getState()?.mainIsolateId;
  if (!id) throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');
  return id;
}

function stripPackagePrefix(uri: string): string {
  // Leave package: URIs intact; strip leading "./" if present.
  if (uri.startsWith('./')) return uri.slice(2);
  return uri;
}

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// ── Resume-mode mapping ─────────────────────────────────────────────────────

export function resumeModeToStep(mode: ResumeMode): string | undefined {
  switch (mode) {
    case 'continue': return undefined;
    case 'step_into': return 'Into';
    case 'step_over': return 'Over';
    case 'step_out': return 'Out';
    default: throw new Error(`Unknown resume mode: ${String(mode)}`);
  }
}

// ── Public tool registrations ───────────────────────────────────────────────

export function registerFlutterSetBreakpointTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_set_breakpoint',
      description:
        'Set a breakpoint in the running Flutter app at script_uri:line via ' +
        'the VM Service addBreakpointWithScriptUri RPC. script_uri must be a ' +
        'Dart-resolvable URI — typically "package:<app>/<file>.dart". Pair with ' +
        'flutter_wait_for_pause + flutter_get_stack to inspect the pause, and ' +
        'flutter_resume to continue. Debug builds only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          script_uri: {
            type: 'string',
            description: 'Resolvable Dart script URI, e.g. "package:myapp/login_page.dart".',
          },
          line: {
            type: 'number',
            description: '1-based line number in the script.',
          },
          column: {
            type: 'number',
            description: 'Optional 1-based column number.',
          },
          device_id: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
        },
        required: ['script_uri', 'line'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const scriptUri = params.script_uri;
        if (typeof scriptUri !== 'string' || scriptUri.trim().length === 0) {
          throw new Error('script_uri is required (non-empty string)');
        }
        const line = params.line;
        if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
          throw new Error('line must be a positive integer');
        }
        const column = params.column;
        if (column !== undefined && (typeof column !== 'number' || !Number.isInteger(column) || column < 0)) {
          throw new Error('column, if provided, must be a non-negative integer');
        }

        const { deviceId, client } = await resolveClient(params.device_id);
        const state = ensureManager(deviceId);
        await ensureDebugSubscription(client, state);

        const isolateId = requireIsolateId(client);
        const rpcParams: Record<string, unknown> = {
          isolateId,
          scriptUri: stripPackagePrefix(scriptUri),
          line,
        };
        if (column !== undefined) rpcParams.column = column;

        const raw = await client.callMethod('addBreakpointWithScriptUri', rpcParams);
        const bp = (raw as { id?: string; resolved?: boolean; location?: Record<string, unknown> });
        const id = typeof bp.id === 'string' ? bp.id : `bp-${Date.now()}`;

        const info: BreakpointInfo = {
          id,
          scriptUri,
          line,
          column: typeof column === 'number' ? column : undefined,
          resolved: bp.resolved === true,
        };
        state.breakpoints.set(id, info);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              breakpoint: info,
              raw_location: bp.location,
              hint: 'Call flutter_wait_for_pause to block until the breakpoint fires.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_set_breakpoint] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerFlutterRemoveBreakpointTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_remove_breakpoint',
      description:
        'Remove a previously-set breakpoint by id (from flutter_set_breakpoint).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          breakpoint_id: { type: 'string', description: 'Breakpoint id returned from flutter_set_breakpoint.' },
          device_id: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
        },
        required: ['breakpoint_id'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const bpId = params.breakpoint_id;
        if (typeof bpId !== 'string' || bpId.trim().length === 0) {
          throw new Error('breakpoint_id is required (non-empty string)');
        }

        const { deviceId, client } = await resolveClient(params.device_id);
        const state = ensureManager(deviceId);
        const isolateId = requireIsolateId(client);

        await client.callMethod('removeBreakpoint', { isolateId, breakpointId: bpId });
        state.breakpoints.delete(bpId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'ok', deviceId, removed: bpId }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_remove_breakpoint] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerFlutterResumeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_resume',
      description:
        'Resume a paused Flutter isolate. mode="continue" runs until the next ' +
        'pause event; mode="step_into" / "step_over" / "step_out" take a single ' +
        'step. Must be called on a currently-paused isolate (see flutter_wait_for_pause).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: ['continue', 'step_into', 'step_over', 'step_out'],
            description: 'Resume mode (default: "continue").',
          },
          device_id: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const modeRaw = params.mode;
        const mode: ResumeMode =
          typeof modeRaw === 'string' && ['continue', 'step_into', 'step_over', 'step_out'].includes(modeRaw)
            ? (modeRaw as ResumeMode)
            : 'continue';

        const { deviceId, client } = await resolveClient(params.device_id);
        const state = ensureManager(deviceId);
        const isolateId = requireIsolateId(client);

        const step = resumeModeToStep(mode);
        const rpcParams: Record<string, unknown> = { isolateId };
        if (step !== undefined) rpcParams.step = step;

        await client.callMethod('resume', rpcParams);
        // The Debug stream Resume event normally clears state; set it eagerly
        // in case the stream subscription has not yet fired.
        state.pause = { paused: false };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'ok', deviceId, mode, step }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_resume] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerFlutterGetStackTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_get_stack',
      description:
        'Return the current call stack of the (paused) main isolate via getStack. ' +
        'Each frame includes function name, script URI, line, and locals scope. ' +
        'Most useful while the isolate is paused at a breakpoint.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Maximum frames to return from the VM.' },
          device_id: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const limitRaw = params.limit;
        if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw <= 0)) {
          throw new Error('limit, if provided, must be a positive integer');
        }

        const { deviceId, client } = await resolveClient(params.device_id);
        const isolateId = requireIsolateId(client);

        const rpcParams: Record<string, unknown> = { isolateId };
        if (typeof limitRaw === 'number') rpcParams.limit = limitRaw;

        const raw = await client.callMethod('getStack', rpcParams);
        const frames = Array.isArray((raw as { frames?: unknown[] }).frames)
          ? ((raw as { frames: Array<Record<string, unknown>> }).frames).map((f) => summariseFrame(f))
          : [];

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              truncated: Boolean((raw as { truncated?: boolean }).truncated),
              frame_count: frames.length,
              frames,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_get_stack] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export interface StackFrameSummary {
  index: number;
  function?: string;
  kind?: string;
  location?: { script_uri?: string; token_pos?: number; line?: number; column?: number };
  vars?: string[];
}

/**
 * Keep the raw VM frame shape at arm's length — we only expose what LLMs
 * tend to use. Exported for unit coverage.
 */
export function summariseFrame(frame: Record<string, unknown>): StackFrameSummary {
  const index = typeof frame.index === 'number' ? frame.index : 0;
  const fn = frame.function as Record<string, unknown> | undefined;
  const functionName = typeof fn?.name === 'string' ? fn.name : undefined;
  const kind = typeof frame.kind === 'string' ? frame.kind : undefined;
  const loc = frame.location as Record<string, unknown> | undefined;
  const locScript = loc?.script as Record<string, unknown> | undefined;

  const location = loc ? {
    script_uri: typeof locScript?.uri === 'string' ? locScript.uri : undefined,
    token_pos: typeof loc.tokenPos === 'number' ? loc.tokenPos : undefined,
    line: typeof loc.line === 'number' ? loc.line : undefined,
    column: typeof loc.column === 'number' ? loc.column : undefined,
  } : undefined;

  const vars = Array.isArray(frame.vars)
    ? (frame.vars as Array<Record<string, unknown>>)
        .map((v) => typeof v.name === 'string' ? v.name : null)
        .filter((n): n is string => n !== null)
    : undefined;

  return { index, function: functionName, kind, location, vars };
}

export function registerFlutterWaitForPauseTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_wait_for_pause',
      description:
        'Block (by polling) until the main isolate reports a pause event ' +
        '(breakpoint hit, paused-on-start, or exception). Returns the pause ' +
        'reason and timestamp on success, or {timeout: true} after timeout_ms. ' +
        'Mirrors the app_wait_for pattern.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          timeout_ms: { type: 'number', description: 'Maximum wait in ms (default: 10000, max: 120000).' },
          poll_interval_ms: { type: 'number', description: 'Polling interval (default 50ms).' },
          device_id: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const timeoutMs = typeof params.timeout_ms === 'number' && params.timeout_ms > 0
          ? Math.min(Math.floor(params.timeout_ms), 120_000)
          : 10_000;
        const pollInterval = typeof params.poll_interval_ms === 'number' && params.poll_interval_ms > 0
          ? Math.min(Math.floor(params.poll_interval_ms), 1_000)
          : 50;

        const { deviceId, client } = await resolveClient(params.device_id);
        const state = ensureManager(deviceId);
        await ensureDebugSubscription(client, state);

        const started = Date.now();
        while (!state.pause.paused) {
          if (Date.now() - started >= timeoutMs) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'timeout',
                  timeout: true,
                  deviceId,
                  waited_ms: Date.now() - started,
                }, null, 2),
              }],
            };
          }
          await sleep(pollInterval);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'paused',
              deviceId,
              reason: state.pause.reason,
              paused_at: state.pause.pausedAt,
              waited_ms: Date.now() - started,
              hint: 'Call flutter_get_stack to read the frames, then flutter_resume to continue.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_wait_for_pause] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
