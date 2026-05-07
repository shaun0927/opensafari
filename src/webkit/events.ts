/**
 * events.ts — Typed event adapters for WebKit Remote Debugging Protocol.
 *
 * Extracted from client.ts (#706 5/5). Behavior-preserving: same event names,
 * same payload shapes, same emission timing as prior client.ts implementation.
 *
 * Owns:
 *   - Typed payload interfaces for all domain events surfaced to callers
 *   - EventBridge class: subscribes to raw transport + TargetSessionManager events,
 *     re-emits typed events on the client EventEmitter, and provides typed
 *     convenience-listener methods (onConsole, onPageLoad, onRequest, onResponse, onError)
 *
 * Does NOT own: transport lifecycle, target session state, browser commands,
 *               heartbeat, reconnection.
 */

import { EventEmitter } from 'events';
import type { ProtocolTransport } from './protocol-transport';

// ========== Typed payload interfaces ==========

/** Payload emitted as `target:created` on WebKitClient. */
export interface TargetCreatedPayload {
  targetId: string;
  url: string;
}

/** Payload emitted as `target:destroyed` on WebKitClient. */
export interface TargetDestroyedPayload {
  targetId: string;
}

/** Typed console message surfaced via `onConsole()`. */
export interface ConsoleMessage {
  type: string;
  text: string;
}

/** Typed request info surfaced via `onRequest()`. */
export interface RequestInfo {
  url: string;
  method: string;
}

/** Typed response info surfaced via `onResponse()`. */
export interface ResponseInfo {
  url: string;
  status: number;
}

/** Typed JS error info surfaced via `onError()`. */
export interface ErrorInfo {
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
}

// ========== Adapter interface ==========

/**
 * Minimal interface EventBridge needs from WebKitClient to enable domains
 * before attaching event listeners.
 */
export interface EventBridgeHost {
  enableDomain(domain: string): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

// ========== EventBridge ==========

/**
 * Bridges raw protocol events from the transport and TargetSessionManager
 * onto the WebKitClient EventEmitter with typed payloads.
 *
 * Call `attach()` once during construction to wire up all event forwarding.
 */
export class EventBridge {
  private attached = false;

  constructor(
    private readonly transport: ProtocolTransport,
    private readonly targetSessionEmitter: EventEmitter,
    private readonly host: EventBridgeHost & EventEmitter,
  ) {}

  /**
   * Wire up all transport and target-session event forwarding.
   * Idempotent — repeat calls are no-ops so we never double-wrap transport.emit
   * or stack duplicate target lifecycle listeners.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.bindTransportForwarding();
    this.bindTargetLifecycle();
  }

  /**
   * Forward all domain events emitted by the transport onto the host EventEmitter.
   * transport:close and transport:error are intentionally excluded — those are
   * handled by WebKitClient directly for connection-state tracking.
   *
   * Implementation: monkey-patches transport.emit so every event is also
   * forwarded to the host. This preserves the existing wildcard-forwarding
   * behavior from before extraction.
   */
  private bindTransportForwarding(): void {
    const originalEmit = this.transport.emit.bind(this.transport);
    (this.transport as any).emit = (event: string, ...args: any[]): boolean => {
      const result = originalEmit(event, ...args);
      if (
        event !== 'transport:close' &&
        event !== 'transport:error' &&
        event !== 'newListener' &&
        event !== 'removeListener'
      ) {
        (EventEmitter.prototype.emit as any).call(this.host, event, ...args);
      }
      return result;
    };
  }

  /**
   * Forward target lifecycle events emitted by TargetSessionManager onto the host.
   * Preserves the `target:created` / `target:destroyed` shape consumed by callers.
   */
  private bindTargetLifecycle(): void {
    this.targetSessionEmitter.on('target:created', (payload: TargetCreatedPayload) => {
      this.host.emit('target:created', payload);
    });

    this.targetSessionEmitter.on('target:destroyed', (payload: TargetDestroyedPayload) => {
      this.host.emit('target:destroyed', payload);
    });
  }

  // ========== Typed convenience listeners ==========

  /**
   * Attach `event` on `host` with `listener` synchronously, then enable `domain`.
   * If the enable fails, detach the listener and surface the error so callers
   * are not left silently subscribed to a domain that never woke up.
   *
   * Attaching the listener before awaiting enableDomain closes the window where
   * an event fires between the resolver send and the promise microtask.
   */
  private wireDomainListener(
    domain: string,
    event: string,
    listener: (...args: any[]) => void,
  ): void {
    this.host.on(event, listener);
    this.host.enableDomain(domain).catch((err: unknown) => {
      this.host.removeListener(event, listener);
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[EventBridge] Failed to enable ${domain} domain: ${reason}`);
    });
  }

  /**
   * Subscribe to Console domain events with a typed handler.
   * Enables the Console domain automatically.
   *
   * Translates raw `Console.messageAdded` params → `ConsoleMessage`.
   */
  onConsole(handler: (msg: ConsoleMessage) => void): void {
    this.wireDomainListener('Console', 'Console.messageAdded', (params: any) => {
      handler({
        type: params.message?.level ?? params.message?.type ?? 'log',
        text: params.message?.text ?? '',
      });
    });
  }

  /**
   * Subscribe to Page load events with a zero-argument handler.
   * Enables the Page domain automatically.
   */
  onPageLoad(handler: () => void): void {
    this.wireDomainListener('Page', 'Page.loadEventFired', handler);
  }

  /**
   * Subscribe to Network request events with a typed handler.
   * Enables the Network domain automatically.
   *
   * Translates raw `Network.requestWillBeSent` params → `RequestInfo`.
   */
  onRequest(handler: (request: RequestInfo) => void): void {
    this.wireDomainListener('Network', 'Network.requestWillBeSent', (params: any) => {
      handler({
        url: params.request?.url ?? '',
        method: params.request?.method ?? 'GET',
      });
    });
  }

  /**
   * Subscribe to Network response events with a typed handler.
   * Enables the Network domain automatically.
   *
   * Translates raw `Network.responseReceived` params → `ResponseInfo`.
   */
  onResponse(handler: (response: ResponseInfo) => void): void {
    this.wireDomainListener('Network', 'Network.responseReceived', (params: any) => {
      handler({
        url: params.response?.url ?? '',
        status: params.response?.status ?? 0,
      });
    });
  }

  /**
   * Subscribe to JavaScript error events with a typed handler.
   * WebKit surfaces JS errors via Console.messageAdded (level "error", source "javascript").
   * Enables the Console domain automatically.
   *
   * Note: Runtime.exceptionThrown is Chrome-specific and not available in WebKit.
   */
  onError(handler: (error: ErrorInfo) => void): void {
    this.wireDomainListener('Console', 'Console.messageAdded', (params: any) => {
      const msg = params.message ?? {};
      if (msg.level === 'error' && msg.source === 'javascript') {
        const frames = msg.stackTrace?.callFrames ?? [];
        const stackLines = frames.map((f: any) =>
          `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`
        );
        handler({
          message: msg.text ?? 'Unknown error',
          stack: stackLines.length ? stackLines.join('\n') : undefined,
          source: msg.url ?? undefined,
          line: msg.line ?? undefined,
          column: msg.column ?? undefined,
        });
      }
    });
  }
}
