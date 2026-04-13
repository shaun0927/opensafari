/**
 * Type definitions for the Dart VM Service Protocol and Flutter extensions.
 */

/** VM Service JSON-RPC request */
export interface VMServiceRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** VM Service JSON-RPC response */
export interface VMServiceResponse {
  jsonrpc: '2.0';
  id: string;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** VM Service event notification */
export interface VMServiceEvent {
  jsonrpc: '2.0';
  method: string;
  params: {
    streamId: string;
    event: {
      kind: string;
      message?: string;
      bytes?: string;
      timestamp?: number;
      isolate?: VMIsolateRef;
      [key: string]: unknown;
    };
  };
}

/** Reference to a Dart isolate */
export interface VMIsolateRef {
  type: 'IsolateRef' | '@Isolate';
  id: string;
  name: string;
  number?: string;
}

/** VM info returned by getVM */
export interface VMInfo {
  type: 'VM';
  name: string;
  architectureBits: number;
  hostCPU: string;
  operatingSystem: string;
  targetCPU: string;
  version: string;
  pid: number;
  isolates: VMIsolateRef[];
  isolateGroups?: Array<{ type: string; id: string; name: string }>;
}

/** Connection state for a Flutter VM Service session */
export interface FlutterConnectionState {
  /** The HTTP URL of the Dart VM Service (e.g. http://127.0.0.1:50642/abc=/) */
  httpUrl: string;
  /** The WebSocket URL derived from httpUrl */
  wsUrl: string;
  /** Whether the connection is currently active */
  connected: boolean;
  /** The bundle ID of the connected app (if known) */
  bundleId?: string;
  /** The device UDID */
  deviceId: string;
  /** VM info from initial handshake */
  vmInfo?: VMInfo;
  /** The main isolate ID */
  mainIsolateId?: string;
}

/** Options for connecting to a Flutter app */
export interface FlutterConnectOptions {
  /** Device UDID */
  deviceId: string;
  /** Explicit VM Service URL (skips discovery) */
  vmServiceUrl?: string;
  /** Bundle ID to filter logs during discovery */
  bundleId?: string;
  /** Discovery timeout in ms (default: 10000) */
  timeout?: number;
}
