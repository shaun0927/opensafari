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
  FlutterVMClientOptions,
  DartVersion,
} from './flutter-types';
import {
  discoverVMServiceUrl,
  httpToWsUrl,
  isValidVMServiceUrl,
  rememberVMServiceUrl,
  forgetVMServiceUrl,
} from './vm-service-discovery';
import {
  DEFAULT_FLUTTER_VM_REQUEST_TIMEOUT_MS,
  DEFAULT_FLUTTER_VM_HEAVY_TIMEOUT_MS,
  DEFAULT_FLUTTER_VM_CONNECT_TIMEOUT_MS,
  DEFAULT_FLUTTER_VM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_FLUTTER_VM_RECONNECT_MAX_ATTEMPTS,
  DEFAULT_FLUTTER_VM_RECONNECT_BASE_DELAY_MS,
  DEFAULT_FLUTTER_VM_RECONNECT_MAX_DELAY_MS,
} from '../config/defaults';


type EventCallback = (event: VMServiceEvent['params']['event']) => void;

/** Methods that may legitimately take longer than the default 10 s timeout
 *  (large widget tree dumps, hot-reload, hot-restart, evaluate, etc.). When
 *  the caller does not pass an explicit timeoutMs, these get the heavy
 *  timeout instead of the default. */
const HEAVY_METHODS = new Set<string>([
  'reloadSources',
  'evaluate',
  'evaluateInFrame',
]);
const HEAVY_EXT_PREFIXES = [
  'ext.flutter.inspector.',
  'ext.flutter.hotRestart',
  'ext.flutter.reassemble',
];

function isHeavyMethod(method: string): boolean {
  if (HEAVY_METHODS.has(method)) return true;
  return HEAVY_EXT_PREFIXES.some((p) => method.startsWith(p));
}

/**
 * Parse a Dart VM `version` string (e.g. "3.11.3 (stable) ... on \"ios_arm64\"")
 * into its semver components. Returns `null` when the string does not begin
 * with a recognisable `MAJOR.MINOR.PATCH` sequence.
 *
 * The Dart SDK major correlates 1:1 with the Flutter major release line:
 * Dart 3.x ships with Flutter 3.x, Dart 2.x ships with Flutter 2.x.
 */
export function parseDartVersion(versionString: string | undefined | null): DartVersion | null {
  if (!versionString || typeof versionString !== 'string') return null;
  const match = versionString.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

export class FlutterVMClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }>();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private state: FlutterConnectionState | null = null;
  /** Streams the caller explicitly subscribed to via `streamListen`. Replayed
   *  after a successful reconnect so user-level event subscriptions survive
   *  transient WebSocket drops. */
  private subscribedStreams = new Set<string>();
  /** Last successful `connect()` arguments, captured so `attemptReconnect`
   *  can rebuild the session without forcing the caller to retry manually. */
  private lastConnectOptions: FlutterConnectOptions | null = null;
  /** True from `connect()` start until `disconnect()` — the heartbeat and
   *  the close-handler use this to decide whether a close was intentional. */
  private wantOpen = false;
  /** True while `attemptReconnect` is in flight; prevents overlapping retries
   *  triggered by both the heartbeat and the WS close handler. */
  private reconnecting = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options: Required<FlutterVMClientOptions>;
  /** Listeners notified when a reconnect succeeds (used by external modules
   *  that need to re-register breakpoints/inspector overlays). */
  private reconnectListeners = new Set<() => void>();

  constructor(options?: FlutterVMClientOptions) {
    this.options = {
      requestTimeoutMs: options?.requestTimeoutMs ?? DEFAULT_FLUTTER_VM_REQUEST_TIMEOUT_MS,
      heavyRequestTimeoutMs: options?.heavyRequestTimeoutMs ?? DEFAULT_FLUTTER_VM_HEAVY_TIMEOUT_MS,
      connectTimeoutMs: options?.connectTimeoutMs ?? DEFAULT_FLUTTER_VM_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? DEFAULT_FLUTTER_VM_HEARTBEAT_INTERVAL_MS,
      reconnectMaxAttempts: options?.reconnectMaxAttempts ?? DEFAULT_FLUTTER_VM_RECONNECT_MAX_ATTEMPTS,
      reconnectBaseDelayMs: options?.reconnectBaseDelayMs ?? DEFAULT_FLUTTER_VM_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: options?.reconnectMaxDelayMs ?? DEFAULT_FLUTTER_VM_RECONNECT_MAX_DELAY_MS,
    };
  }

  /** Get the current connection state */
  getState(): FlutterConnectionState | null {
    return this.state;
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to reconnect-success notifications. Returns an unsubscribe
   *  function. Used by tools that hold isolate-scoped state (breakpoints,
   *  inspector selection) to rebuild it after the socket flapped. */
  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * Connect to a Flutter app's Dart VM Service.
   * Auto-discovers the URL if not provided explicitly.
   */
  async connect(options: FlutterConnectOptions): Promise<FlutterConnectionState> {
    this.lastConnectOptions = options;
    this.wantOpen = true;

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
    const dartVersion = parseDartVersion(vmInfo.version);

    this.state = {
      httpUrl,
      wsUrl,
      connected: true,
      bundleId: options.bundleId,
      deviceId: options.deviceId,
      vmInfo,
      mainIsolateId: mainIsolate?.id,
      dartVersionString: vmInfo.version,
      dartVersion,
    };

    // Remember the URL so future `flutter_connect` calls in this MCP session
    // can skip the expensive log scan.
    rememberVMServiceUrl(options.deviceId, httpUrl);

    // Subscribe to the Isolate stream so stale `mainIsolateId` after a
    // hot-restart or background isolate exit gets corrected automatically.
    // Failures here are non-fatal: the connection is still usable, we just
    // lose the auto-update behaviour.
    try {
      await this.subscribeIsolateLifecycle();
    } catch (err) {
      console.error(
        `[FlutterVMClient] Isolate stream subscription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-apply any user-requested event streams that survived a reconnect.
    for (const streamId of this.subscribedStreams) {
      if (streamId === 'Isolate') continue; // handled above
      try {
        await this.callMethod('streamListen', { streamId });
      } catch {
        // Best-effort; caller may re-subscribe
      }
    }

    // Application-level heartbeat — cheap `getVersion` call every N seconds.
    // Catches half-open sockets where TCP keepalive hasn't fired yet
    // (common when ios-webkit-debug-proxy restarts under us).
    this.startHeartbeat();

    return this.state;
  }

  /**
   * Parsed Dart SDK version captured at connect time. `null` when the VM
   * version string was unparsable; `undefined` before `connect()` completes.
   */
  getDartVersion(): DartVersion | null | undefined {
    return this.state?.dartVersion;
  }

  /**
   * Approximate Flutter major based on the Dart SDK major (Dart 3.x → Flutter
   * 3.x, Dart 2.x → Flutter 2.x). Returns `null` when the version is unknown.
   */
  getFlutterMajor(): number | null {
    const v = this.state?.dartVersion;
    return v ? v.major : null;
  }

  /** Disconnect from the VM Service */
  async disconnect(): Promise<void> {
    this.wantOpen = false;
    this.reconnecting = false;
    this.stopHeartbeat();

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
    this.subscribedStreams.clear();
    this.reconnectListeners.clear();
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * @param method  VM Service / `ext.flutter.*` method name
   * @param params  JSON-RPC params object
   * @param options.timeoutMs Override the default timeout. Heavy methods
   *   (widget tree, hot reload, evaluate, *.inspector.*) get a longer
   *   default automatically — pass an explicit value to force.
   */
  async callMethod(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new FlutterVMError('Not connected to VM Service', 'NOT_CONNECTED');
    }

    const timeoutMs = options?.timeoutMs
      ?? (isHeavyMethod(method) ? this.options.heavyRequestTimeoutMs : this.options.requestTimeoutMs);

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
          `Request timeout: ${method} (${timeoutMs}ms)`,
          'REQUEST_TIMEOUT',
        ));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
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
   * Get the root widget summary tree via the Flutter Inspector.
   *
   * Version-aware branching (issue #436):
   * - Flutter 3.x (Dart major >= 3): try
   *   `ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews` first, fall
   *   back to `getRootWidgetSummaryTree` on VM Service error -32000 (or any
   *   error — older 3.0/3.1 builds occasionally omit WithPreviews too).
   * - Flutter 2.x (Dart major < 3): skip `WithPreviews` entirely and call
   *   `getRootWidgetSummaryTree` directly; the preview variant is unreliable
   *   or absent on 2.x inspector surfaces.
   * - Unknown version (no `vm.version` parsed yet): preserve the historical
   *   try/catch behaviour — attempt `WithPreviews` first, fall back on any
   *   error.
   *
   * Returns a structured JSON node with `type`, `description`, and
   * `creationLocation` (file:line:column) per widget. `objectGroup` is a
   * Flutter-Inspector lifetime scope — a stable group name is fine for
   * LLM-driven introspection; DevTools rotates groups per request to manage
   * memory but for one-shot MCP calls the default is safe.
   */
  async getRootWidgetSummaryTree(
    options?: { objectGroup?: string },
  ): Promise<Record<string, unknown>> {
    const params = { objectGroup: options?.objectGroup ?? 'opensafari-root' };
    const dartVersion = this.state?.dartVersion;

    // Flutter 2.x: skip WithPreviews entirely.
    if (dartVersion && dartVersion.major < 3) {
      return this.callServiceExtension('inspector.getRootWidgetSummaryTree', params);
    }

    // Flutter 3.x or unknown: try WithPreviews first, fall back on error.
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

  /**
   * Perform a Dart-side hit-test at a physical-pixel coordinate, then select
   * the topmost RenderBox's Element via `WidgetInspectorService`, and return
   * the selected summary widget.
   *
   * Flutter 3.11 does NOT expose `ext.flutter.inspector.screenToSummaryTree`
   * (verified on the live extension list for iPhone 16 simulator). Instead,
   * we drive the hit-test via `evaluate` against the root library:
   *
   *   1. Convert physical (x,y) to logical pixels using `devicePixelRatio`.
   *   2. Call `WidgetsBinding.instance.renderViewElement` /
   *      `renderView.hitTest(HitTestResult(), position: Offset(...))`.
   *   3. Walk `HitTestResult.path` for the topmost `RenderBox` whose
   *      `debugCreator` points at an Element, then feed that Element to
   *      `WidgetInspectorService.instance.setSelection`.
   *   4. Read back via `getSelectedSummaryWidget`.
   *
   * Returns the raw inspector selection payload (same shape as
   * `getSelectedWidget`), or an object `{ hit: false }` if no widget was hit.
   */
  async selectWidgetAtPoint(options: {
    physicalX: number;
    physicalY: number;
    devicePixelRatio: number;
    objectGroup?: string;
  }): Promise<Record<string, unknown>> {
    const { physicalX, physicalY, devicePixelRatio } = options;
    const objectGroup = options.objectGroup ?? 'opensafari-hit';

    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
      throw new FlutterVMError(
        `Invalid devicePixelRatio: ${devicePixelRatio}`,
        'INVALID_DPR',
      );
    }

    // The objectGroup is interpolated into a Dart string literal below, so
    // reject anything that could break out of the quoted context. The VM
    // Service only uses this as an inspector lifetime scope — a conservative
    // identifier alphabet is enough.
    if (!/^[A-Za-z0-9_-]+$/.test(objectGroup)) {
      throw new FlutterVMError(
        `Invalid objectGroup: ${objectGroup}`,
        'INVALID_OBJECT_GROUP',
      );
    }

    const logicalX = physicalX / devicePixelRatio;
    const logicalY = physicalY / devicePixelRatio;

    // Dart expression: drive the hit-test and select the topmost RenderBox's
    // Element via WidgetInspectorService. Returns true if something was hit,
    // false otherwise. After this runs, getSelectedSummaryWidget reflects the
    // selection.
    const expression =
      '(() {' +
      '  final binding = WidgetsBinding.instance;' +
      '  final rv = binding.renderViewElement?.renderObject as RenderView?;' +
      '  if (rv == null) return false;' +
      `  final result = HitTestResult();` +
      `  rv.hitTest(result, position: Offset(${logicalX}, ${logicalY}));` +
      '  Element? hitElement;' +
      '  for (final entry in result.path) {' +
      '    final target = entry.target;' +
      '    if (target is RenderObject) {' +
      '      final creator = target.debugCreator;' +
      '      if (creator is DebugCreator) {' +
      '        hitElement = creator.element;' +
      '        break;' +
      '      }' +
      '    }' +
      '  }' +
      '  if (hitElement == null) return false;' +
      `  WidgetInspectorService.instance.setSelection(hitElement, '${objectGroup}');` +
      '  return true;' +
      '})()';

    // The expression references DebugCreator and WidgetInspectorService,
    // which live in package:flutter/src/widgets/widget_inspector.dart and
    // are NOT re-exported through flutter/material.dart. Evaluating against
    // the user app's rootLib would fail with "Undefined name" on any app
    // that only imports material. Resolve the inspector library and scope
    // the evaluate to it so the symbols are always in lexical scope.
    const isolateId = this.state?.mainIsolateId;
    if (!isolateId) {
      throw new FlutterVMError('No main isolate', 'NO_ISOLATE');
    }
    const isolate = await this.callMethod('getIsolate', { isolateId });
    const libs =
      (isolate as { libraries?: Array<{ uri?: string; id?: string }> }).libraries ?? [];
    const inspectorLib = libs.find(
      (l) => l.uri === 'package:flutter/src/widgets/widget_inspector.dart',
    );
    if (!inspectorLib?.id) {
      throw new FlutterVMError(
        'widget_inspector library not loaded in isolate',
        'NO_INSPECTOR_LIB',
      );
    }

    const hitResult = await this.evaluate(expression, { targetId: inspectorLib.id });
    const hitInstance = hitResult as { valueAsString?: string; kind?: string };
    const hit = hitInstance.valueAsString === 'true';

    if (!hit) {
      return { hit: false };
    }

    const selection = await this.getSelectedWidget({ objectGroup });
    return { hit: true, selection };
  }

  /**
   * Walk the parent chain of an inspector widget
   * (`ext.flutter.inspector.getParentChain`). Returns the raw inspector
   * response — caller is responsible for filtering/summarising the chain.
   */
  async getParentChain(options: {
    inspectorRef: string;
    objectGroup?: string;
  }): Promise<Record<string, unknown>> {
    return this.callServiceExtension('inspector.getParentChain', {
      arg: options.inspectorRef,
      objectGroup: options.objectGroup ?? 'opensafari-parent-chain',
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
   * Probe whether the connected VM can compile and evaluate expressions.
   *
   * `evaluate` requires the Dart Development Service (DDS) plus the frontend
   * compiler, which `flutter run --debug` and `--profile` both provide but
   * release builds and apps launched via `xcrun simctl launch` do not. The
   * symptom is a JSON-RPC error with `code: 113` ("Expression compilation
   * error"). This probe issues a trivial `evaluate('1')` against the root
   * library and returns:
   *   - `{ available: true }` on success — the VM accepts arbitrary
   *     expressions, so `FlutterVMInputBackend` operations are safe to
   *     dispatch.
   *   - `{ available: false, reason: 'compile-error-113' }` when the VM
   *     Service rejects with code 113.
   *   - `{ available: false, reason: 'other', message }` for any other
   *     failure (timeout, connection drop, etc).
   *
   * Designed to be cheap (< 500 ms p95) so `getInputBackend()` can call it
   * once per device-discovery cycle without stalling the input path.
   */
  async probeEvaluateCompile(): Promise<
    | { available: true }
    | { available: false; reason: 'compile-error-113' | 'other'; message: string }
  > {
    try {
      await this.evaluate('1');
      return { available: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The VM Service error format is
      //   "VM Service error: <msg> (code: <n>)"
      // produced by the callMethod rejection path. Code 113 is the canonical
      // "Expression compilation error" surfaced for release-mode VMs and any
      // VM that cannot reach the frontend compiler.
      const is113 = /\(code:\s*113\)/.test(message);
      return {
        available: false,
        reason: is113 ? 'compile-error-113' : 'other',
        message,
      };
    }
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
    this.subscribedStreams.add(streamId);
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
      }, this.options.connectTimeoutMs);

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
        // Reject any in-flight requests so callers don't hang waiting for
        // a response on a dead socket. They'll surface as `DISCONNECTED`,
        // which the auto-retry layer (PR2) can act on.
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new FlutterVMError('Connection closed', 'DISCONNECTED'));
          this.pending.delete(id);
        }
        // Schedule a reconnect when the close was not intentional. Skip when
        // the user called `disconnect()` (wantOpen=false), when another
        // attempt is already running, or when there are no captured
        // connect options (only `connect()` populates them).
        if (this.wantOpen && !this.reconnecting && this.lastConnectOptions) {
          // Cached URL is presumed stale on close — drop it so the next
          // `discoverVMServiceUrl` does a fresh scan.
          forgetVMServiceUrl(this.lastConnectOptions.deviceId);
          void this.attemptReconnect();
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });
    });
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatIntervalMs;
    if (interval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) return;
      // `getVersion` is the cheapest VM Service call (no isolate, no params,
      // returns ~50 bytes). Failure here means the socket is half-open or
      // the proxy died — trigger the reconnect path the same way `close`
      // would.
      this.callMethod('getVersion', undefined, { timeoutMs: 5000 }).catch(() => {
        if (this.wantOpen && !this.reconnecting && this.lastConnectOptions) {
          forgetVMServiceUrl(this.lastConnectOptions.deviceId);
          try {
            this.ws?.terminate?.();
          } catch {
            // ignore — the `close` handler will fire next tick anyway
          }
          void this.attemptReconnect();
        }
      });
    }, interval);
    // Unref so a stalled heartbeat doesn't keep Node alive at shutdown.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnect ───────────────────────────────────────────────────────────

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting) return;
    if (!this.wantOpen) return;
    if (!this.lastConnectOptions) return;

    this.reconnecting = true;
    this.stopHeartbeat();

    const opts = this.lastConnectOptions;
    const max = this.options.reconnectMaxAttempts;
    const base = this.options.reconnectBaseDelayMs;
    const cap = this.options.reconnectMaxDelayMs;

    for (let attempt = 1; attempt <= max; attempt++) {
      const backoff = Math.min(base * Math.pow(2, attempt - 1), cap);
      const jitter = backoff * 0.2 * (2 * Math.random() - 1);
      const delay = Math.max(0, Math.round(backoff + jitter));
      console.error(
        `[FlutterVMClient] Reconnect attempt ${attempt}/${max} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));

      if (!this.wantOpen) {
        this.reconnecting = false;
        return;
      }

      try {
        // Force re-discovery on the first reattempt since the cached URL
        // already failed; subsequent attempts let the cache help in case
        // a new VM Service came up at the same port.
        await this.connect({ ...opts, vmServiceUrl: undefined });
        console.error('[FlutterVMClient] Reconnected successfully');
        this.reconnecting = false;
        for (const listener of this.reconnectListeners) {
          try {
            listener();
          } catch {
            // listener errors must not break the reconnect loop
          }
        }
        return;
      } catch (err) {
        console.error(
          `[FlutterVMClient] Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.reconnecting = false;
    console.error(
      `[FlutterVMClient] Failed to reconnect after ${max} attempts`,
    );
  }

  // ── Isolate lifecycle ───────────────────────────────────────────────────

  private async subscribeIsolateLifecycle(): Promise<void> {
    // Idempotent: VM Service rejects duplicate `streamListen` with a
    // 103 error which we can safely ignore.
    try {
      await this.callMethod('streamListen', { streamId: 'Isolate' });
      this.subscribedStreams.add('Isolate');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/code:\s*103/.test(msg)) throw err;
    }
    this.eventListeners.set('Isolate', this.eventListeners.get('Isolate') ?? new Set());
    this.eventListeners.get('Isolate')!.add((event) => {
      const kind = event?.kind;
      if (!kind || !this.state) return;
      const isolate = (event as { isolate?: { id?: string; name?: string } }).isolate;
      if (kind === 'IsolateRunnable' && isolate?.id && (isolate.name === 'main' || !this.state.mainIsolateId)) {
        // A new main isolate became runnable (typical after hot-restart) —
        // adopt it so the next service-extension call lands on the live
        // isolate instead of a dead one.
        this.state.mainIsolateId = isolate.id;
      } else if (kind === 'IsolateExit' && isolate?.id === this.state.mainIsolateId) {
        // The main isolate exited. Clear the cached id so service-extension
        // calls fail fast with NO_ISOLATE instead of RPC error 106 later.
        this.state.mainIsolateId = undefined;
      }
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

/**
 * Current number of retained per-device `FlutterVMClient` entries. Exposed
 * for the cache-budget survey (#554) so `diagnose` can flag this cache when
 * it outgrows the budget documented in `docs/memory-budget.md`.
 */
export function getFlutterVMClientCount(): number {
  return clients.size;
}
