/**
 * Dart VM Service Protocol Client
 *
 * WebSocket JSON-RPC 2.0 client for communicating with the Dart VM Service.
 * Provides methods for VM inspection, Flutter service extensions, and
 * event streaming.
 */

import WebSocket from 'ws';
import type {
  VMServiceRequest,
  VMServiceEvent,
  VMInfo,
  FlutterConnectionState,
  FlutterConnectOptions,
} from './flutter-types';
import { discoverVMServiceUrl, httpToWsUrl, isValidVMServiceUrl } from './vm-service-discovery';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

type EventCallback = (event: VMServiceEvent['params']['event']) => void;

export class FlutterVMClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private state: FlutterConnectionState | null = null;

  /** Get the current connection state */
  getState(): FlutterConnectionState | null {
    return this.state;
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to a Flutter app's Dart VM Service.
   * Auto-discovers the URL if not provided explicitly.
   */
  async connect(options: FlutterConnectOptions): Promise<FlutterConnectionState> {
    // Discover or validate URL
    let httpUrl = options.vmServiceUrl;

    if (!httpUrl) {
      const discovered = await discoverVMServiceUrl(options.deviceId, {
        bundleId: options.bundleId,
        timeout: options.timeout,
      });
      if (!discovered) {
        throw new FlutterVMError(
          'Could not discover Dart VM Service URL. Ensure the Flutter app is running in debug or profile mode.',
          'VM_SERVICE_NOT_FOUND',
        );
      }
      httpUrl = discovered;
    }

    if (!isValidVMServiceUrl(httpUrl)) {
      throw new FlutterVMError(
        `Invalid VM Service URL: ${httpUrl}`,
        'INVALID_URL',
      );
    }

    const wsUrl = httpToWsUrl(httpUrl);

    // Connect via WebSocket
    await this.connectWebSocket(wsUrl);

    // Get VM info and find main isolate
    const vmInfo = await this.getVM();
    const mainIsolate = vmInfo.isolates.find((i) => i.name === 'main') ?? vmInfo.isolates[0];

    this.state = {
      httpUrl,
      wsUrl,
      connected: true,
      bundleId: options.bundleId,
      deviceId: options.deviceId,
      vmInfo,
      mainIsolateId: mainIsolate?.id,
    };

    return this.state;
  }

  /** Disconnect from the VM Service */
  async disconnect(): Promise<void> {
    if (this.ws) {
      // Reject all pending requests
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new FlutterVMError('Connection closed', 'DISCONNECTED'));
        this.pending.delete(id);
      }

      this.ws.close();
      this.ws = null;
    }
    if (this.state) {
      this.state.connected = false;
    }
    this.eventListeners.clear();
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async callMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new FlutterVMError('Not connected to VM Service', 'NOT_CONNECTED');
    }

    const id = String(++this.requestId);
    const request: VMServiceRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FlutterVMError(
          `Request timeout: ${method} (${DEFAULT_REQUEST_TIMEOUT_MS}ms)`,
          'REQUEST_TIMEOUT',
        ));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Call a Flutter service extension (ext.flutter.*).
   * Automatically targets the main isolate.
   */
  async callServiceExtension(
    extension: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const isolateId = this.state?.mainIsolateId;
    if (!isolateId) {
      throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');
    }

    const fullMethod = extension.startsWith('ext.') ? extension : `ext.flutter.${extension}`;
    return this.callMethod(fullMethod, { isolateId, ...params });
  }

  // ── VM Methods ──────────────────────────────────────────────────────────

  /** Get VM information */
  async getVM(): Promise<VMInfo> {
    const result = await this.callMethod('getVM');
    return result as unknown as VMInfo;
  }

  /** Get isolate details */
  async getIsolate(isolateId?: string): Promise<Record<string, unknown>> {
    const id = isolateId ?? this.state?.mainIsolateId;
    if (!id) throw new FlutterVMError('No isolate ID', 'NO_ISOLATE');
    return this.callMethod('getIsolate', { isolateId: id });
  }

  // ── Flutter Extensions ──────────────────────────────────────────────────

  /** Dump the full widget tree */
  async getWidgetTree(): Promise<string> {
    const result = await this.callServiceExtension('debugDumpApp');
    return (result as { result?: string }).result ?? JSON.stringify(result);
  }

  /** Dump the render object tree */
  async getRenderTree(): Promise<string> {
    const result = await this.callServiceExtension('debugDumpRenderTree');
    return (result as { result?: string }).result ?? JSON.stringify(result);
  }

  /** Dump the semantics tree in traversal order */
  async getSemanticsTree(): Promise<string> {
    const result = await this.callServiceExtension('debugDumpSemanticsTreeInTraversalOrder');
    return (result as { result?: string }).result ?? JSON.stringify(result);
  }

  /**
   * Get the root widget summary tree via the Flutter Inspector
   * (`ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews`).
   *
   * Returns a structured JSON node with `type`, `description`, and
   * `creationLocation` (file:line:column) per widget. `objectGroup` is
   * a Flutter-Inspector lifetime scope — a stable group name is fine for
   * LLM-driven introspection; DevTools rotates groups per request to
   * manage memory but for one-shot MCP calls the default is safe.
   *
   * Falls back to `getRootWidgetSummaryTree` (without previews) if the
   * WithPreviews variant fails (e.g. VM Service error -32000 on older
   * Flutter versions). If both fail, the original error is rethrown.
   */
  async getRootWidgetSummaryTree(
    options?: { objectGroup?: string },
  ): Promise<Record<string, unknown>> {
    const params = { objectGroup: options?.objectGroup ?? 'opensafari-root' };
    let originalError: unknown;
    try {
      return await this.callServiceExtension('inspector.getRootWidgetSummaryTreeWithPreviews', params);
    } catch (err) {
      originalError = err;
    }
    try {
      return await this.callServiceExtension('inspector.getRootWidgetSummaryTree', params);
    } catch {
      throw originalError;
    }
  }

  /**
   * Get the currently selected widget via the Flutter Inspector
   * (`ext.flutter.inspector.getSelectedSummaryWidget`). The selection is
   * normally set by toggling the in-app inspector overlay (`ext.flutter.inspector.show`)
   * and tapping a widget, or by a follow-up `setSelectionById` tool.
   */
  async getSelectedWidget(
    options?: { objectGroup?: string; previousSelectionId?: string },
  ): Promise<Record<string, unknown>> {
    return this.callServiceExtension('inspector.getSelectedSummaryWidget', {
      objectGroup: options?.objectGroup ?? 'opensafari-selection',
      ...(options?.previousSelectionId ? { previousSelectionId: options.previousSelectionId } : {}),
    });
  }

  /**
   * Toggle the in-app widget inspector overlay
   * (`ext.flutter.inspector.show`). When true, taps on the running app
   * select widgets instead of dispatching to handlers — pair with
   * `getSelectedWidget` to implement coord→widget lookup.
   */
  async setInspectorShow(enabled: boolean): Promise<Record<string, unknown>> {
    return this.callServiceExtension('inspector.show', {
      enabled: enabled ? 'true' : 'false',
    });
  }

  /** Trigger a hot reload */
  async hotReload(): Promise<Record<string, unknown>> {
    const isolateId = this.state?.mainIsolateId;
    if (!isolateId) throw new FlutterVMError('No main isolate', 'NO_ISOLATE');
    return this.callMethod('reloadSources', { isolateId });
  }

  /** Trigger a hot restart */
  async hotRestart(): Promise<Record<string, unknown>> {
    return this.callServiceExtension('hotRestart');
  }

  /** Toggle performance overlay */
  async togglePerformanceOverlay(enabled: boolean): Promise<Record<string, unknown>> {
    return this.callServiceExtension('showPerformanceOverlay', {
      enabled: enabled ? 'true' : 'false',
    });
  }

  /** Toggle debug banner */
  async toggleDebugBanner(enabled: boolean): Promise<Record<string, unknown>> {
    return this.callServiceExtension('debugAllowBanner', {
      enabled: enabled ? 'true' : 'false',
    });
  }

  // ── Expression Evaluation (issue #434) ──────────────────────────────────

  /**
   * Evaluate a Dart expression against the main isolate's root library.
   *
   * Parameters:
   *   expression — any Dart expression (e.g. "1 + 1", "DateTime.now()")
   *   options.isolateId — override the main isolate (optional)
   *   options.targetId — override the root-library target (optional)
   *
   * Returns the raw `@Instance` / `@Error` / `Sentinel` result from the VM.
   */
  async evaluate(
    expression: string,
    options?: { isolateId?: string; targetId?: string },
  ): Promise<Record<string, unknown>> {
    const isolateId = options?.isolateId ?? this.state?.mainIsolateId;
    if (!isolateId) {
      throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');
    }

    let targetId = options?.targetId;
    if (!targetId) {
      const isolate = await this.callMethod('getIsolate', { isolateId });
      const rootLib = (isolate as { rootLib?: { id?: string } }).rootLib;
      if (!rootLib?.id) {
        throw new FlutterVMError(
          'Cannot evaluate: isolate has no rootLib (is the app fully initialised?)',
          'NO_ROOT_LIB',
        );
      }
      targetId = rootLib.id;
    }

    return this.callMethod('evaluate', {
      isolateId,
      targetId,
      expression,
    });
  }

  /**
   * Evaluate a Dart expression inside a specific stack frame. Only meaningful
   * while the isolate is paused at a breakpoint (future work — issue #435).
   */
  async evaluateInFrame(
    frameIndex: number,
    expression: string,
    options?: { isolateId?: string },
  ): Promise<Record<string, unknown>> {
    const isolateId = options?.isolateId ?? this.state?.mainIsolateId;
    if (!isolateId) {
      throw new FlutterVMError('No main isolate found', 'NO_ISOLATE');
    }
    return this.callMethod('evaluateInFrame', {
      isolateId,
      frameIndex,
      expression,
    });
  }

  // ── Event Streaming ─────────────────────────────────────────────────────

  /** Subscribe to a VM Service event stream */
  async streamListen(streamId: string): Promise<void> {
    await this.callMethod('streamListen', { streamId });
  }

  /** Register a callback for events on a stream */
  onEvent(streamId: string, callback: EventCallback): void {
    if (!this.eventListeners.has(streamId)) {
      this.eventListeners.set(streamId, new Set());
    }
    this.eventListeners.get(streamId)!.add(callback);
  }

  /** Remove an event callback */
  offEvent(streamId: string, callback: EventCallback): void {
    this.eventListeners.get(streamId)?.delete(callback);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new FlutterVMError(
          `WebSocket connection timeout: ${wsUrl}`,
          'CONNECT_TIMEOUT',
        ));
      }, DEFAULT_CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new FlutterVMError(
          `WebSocket error: ${err.message}`,
          'CONNECT_ERROR',
        ));
      });

      this.ws.on('close', () => {
        if (this.state) {
          this.state.connected = false;
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Check if it's a response to a pending request
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);

        if (msg.error) {
          entry.reject(new FlutterVMError(
            `VM Service error: ${msg.error.message} (code: ${msg.error.code})`,
            'RPC_ERROR',
          ));
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }

      // Check if it's an event notification
      if (msg.method === 'streamNotify' && msg.params) {
        const event = msg as VMServiceEvent;
        const streamId = event.params.streamId;
        const listeners = this.eventListeners.get(streamId);
        if (listeners) {
          for (const callback of listeners) {
            try {
              callback(event.params.event);
            } catch {
              // Don't let listener errors crash the client
            }
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }
}

export class FlutterVMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'FlutterVMError';
  }
}

// Singleton per device
const clients = new Map<string, FlutterVMClient>();

export function getFlutterVMClient(deviceId: string): FlutterVMClient {
  let client = clients.get(deviceId);
  if (!client) {
    client = new FlutterVMClient();
    clients.set(deviceId, client);
  }
  return client;
}

export function removeFlutterVMClient(deviceId: string): void {
  const client = clients.get(deviceId);
  if (client) {
    client.disconnect();
    clients.delete(deviceId);
  }
}
