/**
 * Fixture builders for WebKit Remote Debugging Protocol messages.
 *
 * Each builder accepts optional field overrides and returns a fully-typed DTO
 * matching the shapes defined in src/types/webkit-rdp.ts. Use these in tests
 * instead of raw object literals cast with `as any`.
 *
 * Usage:
 *   const target = makeWebKitTarget({ id: 'my-tab' });
 *   const event = makeTargetCreatedEvent({ targetInfo: { targetId: 'x', type: 'page' } });
 */

import type {
  WebKitTarget,
} from '../../src/webkit/client';
import type {
  RdpOuterResponse,
  RdpOuterEvent,
  RdpInnerResponse,
  RdpInnerEvent,
  RdpError,
  RdpTargetInfo,
  RdpTargetCreatedParams,
  RdpTargetDestroyedParams,
  RdpDispatchMessageFromTargetParams,
  RdpConsoleCallFrame,
  RdpConsoleMessage,
  RdpConsoleMessageAddedParams,
  RdpRequest,
  RdpRequestWillBeSentParams,
  RdpResponse,
  RdpResponseReceivedParams,
} from '../../src/types/webkit-rdp';

// ─── HTTP /json target list entries ──────────────────────────────────────────

/** Build a fully-typed WebKitTarget (as returned by /json). */
export function makeWebKitTarget(overrides: Partial<WebKitTarget> = {}): WebKitTarget {
  return {
    id: 'page-1',
    title: 'Test Page',
    url: 'https://example.com',
    webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1',
    ...overrides,
  };
}

/** Build a device-redirect stub (no webSocketDebuggerUrl, url = "host:PORT"). */
export function makeDeviceRedirectStub(overrides: Partial<{ id: string; title: string; url: string }> = {}): Omit<WebKitTarget, 'webSocketDebuggerUrl'> & { webSocketDebuggerUrl?: string } {
  return {
    id: '',
    title: '',
    url: 'localhost:9322',
    ...overrides,
  };
}

// ─── RDP protocol primitives ─────────────────────────────────────────────────

/** Build an RdpError object. */
export function makeRdpError(overrides: Partial<RdpError> = {}): RdpError {
  return { message: 'Protocol error', code: -32000, ...overrides };
}

// ─── Outer protocol messages ──────────────────────────────────────────────────

/** Build a successful outer response (ack for Target.sendMessageToTarget). */
export function makeOuterResponse(overrides: Partial<RdpOuterResponse> = {}): RdpOuterResponse {
  return { id: 1, result: {}, ...overrides };
}

/** Build an outer response with an error. */
export function makeOuterErrorResponse(overrides: Partial<RdpOuterResponse> & { error?: RdpError } = {}): RdpOuterResponse {
  const { error, ...rest } = overrides;
  return { id: 1, error: makeRdpError(error), ...rest };
}

/** Build a generic outer event. */
export function makeOuterEvent(method: string, params?: unknown): RdpOuterEvent {
  return params !== undefined ? { method, params } : { method };
}

// ─── Target.targetCreated ─────────────────────────────────────────────────────

/** Build an RdpTargetInfo. */
export function makeTargetInfo(overrides: Partial<RdpTargetInfo> = {}): RdpTargetInfo {
  return { targetId: 'page-1', type: 'page', url: 'https://example.com', ...overrides };
}

/** Build the params for a Target.targetCreated event. */
export function makeTargetCreatedParams(overrides: Partial<RdpTargetCreatedParams> = {}): RdpTargetCreatedParams {
  return { targetInfo: makeTargetInfo(overrides.targetInfo), ...overrides };
}

/** Build a full Target.targetCreated outer event message. */
export function makeTargetCreatedEvent(overrides: Partial<RdpTargetCreatedParams> = {}): RdpOuterEvent & { method: 'Target.targetCreated'; params: RdpTargetCreatedParams } {
  return { method: 'Target.targetCreated', params: makeTargetCreatedParams(overrides) };
}

// ─── Target.targetDestroyed ───────────────────────────────────────────────────

/** Build the params for a Target.targetDestroyed event. */
export function makeTargetDestroyedParams(overrides: Partial<RdpTargetDestroyedParams> = {}): RdpTargetDestroyedParams {
  return { targetId: 'page-1', ...overrides };
}

/** Build a full Target.targetDestroyed outer event message. */
export function makeTargetDestroyedEvent(overrides: Partial<RdpTargetDestroyedParams> = {}): RdpOuterEvent & { method: 'Target.targetDestroyed'; params: RdpTargetDestroyedParams } {
  return { method: 'Target.targetDestroyed', params: makeTargetDestroyedParams(overrides) };
}

// ─── Target.dispatchMessageFromTarget ────────────────────────────────────────

/** Build the params for a Target.dispatchMessageFromTarget event, accepting a pre-serialized message. */
export function makeDispatchMessageFromTargetParams(
  targetId: string,
  innerMessage: RdpInnerResponse | RdpInnerEvent,
): RdpDispatchMessageFromTargetParams {
  return { targetId, message: JSON.stringify(innerMessage) };
}

/** Build a full Target.dispatchMessageFromTarget outer event message. */
export function makeDispatchMessageFromTargetEvent(
  targetId: string,
  innerMessage: RdpInnerResponse | RdpInnerEvent,
): RdpOuterEvent & { method: 'Target.dispatchMessageFromTarget'; params: RdpDispatchMessageFromTargetParams } {
  return {
    method: 'Target.dispatchMessageFromTarget',
    params: makeDispatchMessageFromTargetParams(targetId, innerMessage),
  };
}

// ─── Inner protocol messages ──────────────────────────────────────────────────

/** Build a successful inner response (domain command result). */
export function makeInnerResponse(overrides: Partial<RdpInnerResponse> = {}): RdpInnerResponse {
  return { id: 1, result: {}, ...overrides };
}

/** Build an inner error response. */
export function makeInnerErrorResponse(overrides: Partial<RdpInnerResponse> & { error?: RdpError } = {}): RdpInnerResponse {
  const { error, ...rest } = overrides;
  return { id: 1, error: makeRdpError(error), ...rest };
}

/** Build an inner domain event. */
export function makeInnerEvent(method: string, params?: unknown): RdpInnerEvent {
  return params !== undefined ? { method, params } : { method };
}

// ─── Console.messageAdded ────────────────────────────────────────────────────

/** Build an RdpConsoleCallFrame. */
export function makeConsoleCallFrame(overrides: Partial<RdpConsoleCallFrame> = {}): RdpConsoleCallFrame {
  return { functionName: 'myFunc', url: 'https://example.com/app.js', lineNumber: 10, columnNumber: 5, ...overrides };
}

/** Build an RdpConsoleMessage. */
export function makeConsoleMessage(overrides: Partial<RdpConsoleMessage> = {}): RdpConsoleMessage {
  return {
    level: 'log',
    text: 'test message',
    source: 'console-api',
    ...overrides,
  };
}

/** Build Console.messageAdded params. */
export function makeConsoleMessageAddedParams(overrides: Partial<RdpConsoleMessageAddedParams> & { message?: Partial<RdpConsoleMessage> } = {}): RdpConsoleMessageAddedParams {
  const { message, ...rest } = overrides;
  return { message: makeConsoleMessage(message), ...rest };
}

// ─── Network.requestWillBeSent ────────────────────────────────────────────────

/** Build an RdpRequest. */
export function makeRdpRequest(overrides: Partial<RdpRequest> = {}): RdpRequest {
  return { url: 'https://example.com/api', method: 'GET', ...overrides };
}

/** Build Network.requestWillBeSent params. */
export function makeRequestWillBeSentParams(overrides: Partial<RdpRequestWillBeSentParams> & { request?: Partial<RdpRequest> } = {}): RdpRequestWillBeSentParams {
  const { request, ...rest } = overrides;
  return { request: makeRdpRequest(request), ...rest };
}

// ─── Network.responseReceived ─────────────────────────────────────────────────

/** Build an RdpResponse. */
export function makeRdpResponse(overrides: Partial<RdpResponse> = {}): RdpResponse {
  return { url: 'https://example.com/api', status: 200, ...overrides };
}

/** Build Network.responseReceived params. */
export function makeResponseReceivedParams(overrides: Partial<RdpResponseReceivedParams> & { response?: Partial<RdpResponse> } = {}): RdpResponseReceivedParams {
  const { response, ...rest } = overrides;
  return { response: makeRdpResponse(response), ...rest };
}
