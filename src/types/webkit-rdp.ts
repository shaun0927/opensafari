/**
 * WebKit Remote Debugging Protocol — typed DTOs for message shapes
 * used by WebKitClient. Only fields actually read by the client are typed.
 *
 * All types are plain TypeScript interfaces — no runtime validation library.
 * Use the narrowing helpers (is* functions) to safely cast `unknown` parse results.
 */

// ─── Outer protocol messages (multiplexer layer) ─────────────────────────────

/** A successful response to a command sent to the outer multiplexer. */
export interface RdpOuterResponse {
  id: number;
  result?: unknown;
  error?: RdpError;
}

/** A protocol event from the outer multiplexer (e.g. Target.*). */
export interface RdpOuterEvent {
  method: string;
  params?: unknown;
}

/** Union of all outer messages. */
export type RdpOuterMessage = RdpOuterResponse | RdpOuterEvent;

// ─── Inner protocol messages (per-target domain layer) ────────────────────────

/** A successful response to a command sent inside a target. */
export interface RdpInnerResponse {
  id: number;
  result?: unknown;
  error?: RdpError;
}

/** An event emitted by a domain inside a target (e.g. Page.loadEventFired). */
export interface RdpInnerEvent {
  method: string;
  params?: unknown;
}

/** Union of all inner messages. */
export type RdpInnerMessage = RdpInnerResponse | RdpInnerEvent;

// ─── Shared primitives ────────────────────────────────────────────────────────

export interface RdpError {
  message?: string;
  code?: number;
}

// ─── Target.targetCreated params ─────────────────────────────────────────────

export interface RdpTargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

export interface RdpTargetCreatedParams {
  targetInfo: RdpTargetInfo;
}

// ─── Target.targetDestroyed params ───────────────────────────────────────────

export interface RdpTargetDestroyedParams {
  targetId: string;
}

// ─── Target.dispatchMessageFromTarget params ─────────────────────────────────

export interface RdpDispatchMessageFromTargetParams {
  targetId: string;
  message: string;
}

// ─── Console.messageAdded params ─────────────────────────────────────────────

export interface RdpConsoleCallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface RdpConsoleMessage {
  level: string;
  text: string;
  source?: string;
  url?: string;
  line?: number;
  column?: number;
  stackTrace?: {
    callFrames: RdpConsoleCallFrame[];
  };
}

export interface RdpConsoleMessageAddedParams {
  message: RdpConsoleMessage;
}

// ─── Network.requestWillBeSent params ────────────────────────────────────────

export interface RdpRequest {
  url: string;
  method: string;
}

export interface RdpRequestWillBeSentParams {
  request: RdpRequest;
}

// ─── Network.responseReceived params ─────────────────────────────────────────

export interface RdpResponse {
  url: string;
  status: number;
}

export interface RdpResponseReceivedParams {
  response: RdpResponse;
}

// ─── Narrowing helpers ────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True when the parsed message is a response (has numeric `id`). */
export function isRdpResponse(v: unknown): v is RdpOuterResponse | RdpInnerResponse {
  return isObject(v) && typeof v['id'] === 'number';
}

/** True when the parsed message is an event (has string `method`, no `id`). */
export function isRdpEvent(v: unknown): v is RdpOuterEvent | RdpInnerEvent {
  return isObject(v) && typeof v['method'] === 'string' && !('id' in v);
}

/** Narrow to Target.targetCreated event. */
export function isTargetCreatedEvent(v: unknown): v is { method: 'Target.targetCreated'; params: RdpTargetCreatedParams } {
  if (!isRdpEvent(v) || v['method'] !== 'Target.targetCreated') return false;
  const params = v['params'];
  return isObject(params) && isObject(params['targetInfo']);
}

/** Narrow to Target.targetDestroyed event. */
export function isTargetDestroyedEvent(v: unknown): v is { method: 'Target.targetDestroyed'; params: RdpTargetDestroyedParams } {
  if (!isRdpEvent(v) || v['method'] !== 'Target.targetDestroyed') return false;
  const params = v['params'];
  return isObject(params) && typeof params['targetId'] === 'string';
}

/** Narrow to Target.dispatchMessageFromTarget event. */
export function isDispatchMessageFromTargetEvent(
  v: unknown,
): v is { method: 'Target.dispatchMessageFromTarget'; params: RdpDispatchMessageFromTargetParams } {
  if (!isRdpEvent(v) || v['method'] !== 'Target.dispatchMessageFromTarget') return false;
  const params = v['params'];
  return isObject(params) && typeof params['targetId'] === 'string' && typeof params['message'] === 'string';
}

/** Narrow Console.messageAdded params. */
export function isConsoleMessageAddedParams(v: unknown): v is RdpConsoleMessageAddedParams {
  return isObject(v) && isObject(v['message']);
}

/** Narrow Network.requestWillBeSent params. */
export function isRequestWillBeSentParams(v: unknown): v is RdpRequestWillBeSentParams {
  return isObject(v) && isObject(v['request']);
}

/** Narrow Network.responseReceived params. */
export function isResponseReceivedParams(v: unknown): v is RdpResponseReceivedParams {
  return isObject(v) && isObject(v['response']);
}
