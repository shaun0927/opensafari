/**
 * ProtocolTransport — WebSocket / RDP message-passing layer for WebKit Remote Debugging Protocol.
 *
 * Extracted from client.ts (#706 2/5). Behavior-preserving; same wire protocol; same error semantics.
 *
 * Owns:
 *   - WebSocket connection lifecycle (connect, disconnect, isConnected)
 *   - Outer pending-request map (Target.sendMessageToTarget acks)
 *   - Inner pending-request map (dispatchMessageFromTarget responses)
 *   - Message-ID generation (outer + inner)
 *   - Response routing / event emission
 *
 * Does NOT own: target lifecycle, domain management, heartbeat, browser commands.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ConnectionError, TimeoutError, ProtocolError } from './errors';
import { DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS } from '../config/defaults';

// ========== Interface ==========

/** Handler signature for raw RDP protocol events relayed by the transport. */
export type ProtocolEventHandler = (
  event: string,
  ...args: unknown[]
) => void;

/**
 * Adapter interface used by WebKitClient to interact with the transport layer.
 * Using an interface avoids circular dependencies and allows test doubles.
 */
export interface ProtocolTransport extends NodeJS.EventEmitter {
  /** Connect to a specific WebSocket URL. Resolves when the socket is open. */
  connect(wsUrl: string): Promise<void>;

  /**
   * Close the WebSocket and reject all pending requests. The transport also
   * rejects pending requests automatically when the underlying socket emits
   * `close`, so callers do not need to clear pending state out-of-band.
   */
  disconnect(): Promise<void>;

  /** True when the WebSocket is in OPEN state. */
  isConnected(): boolean;

  /**
   * Subscribe to RDP protocol events relayed by the transport (e.g.
   * `Page.loadEventFired`, `Target.targetCreated`). Lifecycle events
   * (`transport:close`, `transport:error`) and EventEmitter housekeeping
   * events (`newListener`, `removeListener`) are NOT delivered here —
   * subscribe to those via the `EventEmitter` surface directly.
   *
   * Returns an unsubscribe function for symmetry with other reactive APIs.
   */
  onProtocolEvent(handler: ProtocolEventHandler): () => void;

  /**
   * Send a protocol command wrapped in Target.sendMessageToTarget.
   * @param method  RDP method name (e.g. "Page.navigate")
   * @param params  Optional method params
   * @param targetId  The page target to address
   * @param innerMessageId  Caller-allocated inner-message ID (avoids ID-space collision)
   * @param outerMessageId  Caller-allocated outer-message ID
   * @param timeout  Milliseconds before TimeoutError is thrown
   */
  sendToTarget<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    targetId: string,
    innerMessageId: number,
    outerMessageId: number,
    timeout: number,
  ): Promise<T>;
}

// ========== Pending Request Slot ==========

interface PendingSlot {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ========== Concrete Implementation ==========

export interface WebSocketProtocolTransportOptions {
  connectTimeout?: number;
  sendTimeout?: number;
}

/**
 * Concrete ProtocolTransport backed by a WebSocket.
 * Translates WebKit RDP wire-protocol messages into Promise resolution / EventEmitter events.
 */
export class WebSocketProtocolTransport extends EventEmitter implements ProtocolTransport {
  private ws: WebSocket | null = null;
  private _connected = false;

  /** Outer pending requests: Target.sendMessageToTarget ack tracking */
  private readonly outerPending: Map<number, PendingSlot> = new Map();

  /** Inner pending requests: actual domain-command response tracking */
  private readonly innerPending: Map<number, PendingSlot> = new Map();

  /** Subscribers registered via onProtocolEvent (raw RDP event relay). */
  private readonly protocolEventHandlers: Set<ProtocolEventHandler> = new Set();

  constructor(private readonly options: WebSocketProtocolTransportOptions = {}) {
    super();
  }

  // ========== Protocol Event Subscription ==========

  onProtocolEvent(handler: ProtocolEventHandler): () => void {
    this.protocolEventHandlers.add(handler);
    return () => {
      this.protocolEventHandlers.delete(handler);
    };
  }

  /**
   * Emit an RDP protocol event on the EventEmitter surface AND notify every
   * subscriber registered via `onProtocolEvent`. Used in place of the bare
   * `this.emit(event, ...)` calls inside `handleMessage`.
   */
  private emitProtocolEvent(event: string, ...args: unknown[]): void {
    this.emit(event, ...args);
    for (const handler of this.protocolEventHandlers) {
      try {
        handler(event, ...args);
      } catch (err) {
        // Surface listener errors via the standard 'error' channel so a
        // misbehaving subscriber cannot break the message-routing loop.
        this.emit('error', err as Error);
      }
    }
  }

  // ========== Lifecycle ==========

  async connect(wsUrl: string): Promise<void> {
    const connectTimeout =
      this.options.connectTimeout ?? DEFAULT_WEBKIT_CONNECT_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new ConnectionError(`Connection timeout after ${connectTimeout}ms`));
      }, connectTimeout);

      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this._connected = true;
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        this._connected = false;
        // Reject any awaiters immediately rather than letting them hang
        // until their per-request timers expire.
        this.clearPendingRequests();
        this.emit('transport:close');
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        if (!this._connected) {
          reject(new ConnectionError(`WebSocket error: ${err.message}`));
        } else {
          this.emit('transport:error', err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.clearPendingRequests();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ========== Send ==========

  sendToTarget<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    targetId: string,
    innerMessageId: number,
    outerMessageId: number,
    timeout: number,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ConnectionError('WebSocket not connected'));
    }

    const innerPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.innerPending.delete(innerMessageId);
        reject(new TimeoutError(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.innerPending.set(innerMessageId, { resolve, reject, timer });
    });

    // Outer slot: tracks ack from Target.sendMessageToTarget.
    // On outer error (e.g., invalid targetId), propagate to inner so the caller rejects.
    const outerTimer = setTimeout(() => {
      this.outerPending.delete(outerMessageId);
    }, timeout);

    this.outerPending.set(outerMessageId, {
      resolve: () => { /* ack only — real response comes via dispatchMessageFromTarget */ },
      reject: (err: Error) => {
        const inner = this.innerPending.get(innerMessageId);
        if (inner) {
          clearTimeout(inner.timer);
          this.innerPending.delete(innerMessageId);
          inner.reject(err);
        }
      },
      timer: outerTimer,
    });

    const innerMessage = JSON.stringify({ id: innerMessageId, method, params });
    this.ws.send(
      JSON.stringify({
        id: outerMessageId,
        method: 'Target.sendMessageToTarget',
        params: { targetId, message: innerMessage },
      }),
    );

    return innerPromise;
  }

  // ========== Message Routing ==========

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Multiplexed inner response from a page target
    if (msg.method === 'Target.dispatchMessageFromTarget') {
      let innerMsg: any;
      try {
        innerMsg = JSON.parse(msg.params.message);
      } catch {
        return;
      }

      if (innerMsg.id !== undefined) {
        const pending = this.innerPending.get(innerMsg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.innerPending.delete(innerMsg.id);
          if (innerMsg.error) {
            pending.reject(
              new ProtocolError(
                innerMsg.error.message ?? JSON.stringify(innerMsg.error),
                innerMsg.error.code,
              ),
            );
          } else {
            pending.resolve(innerMsg.result);
          }
        }
      } else if (innerMsg.method) {
        // Inner event (e.g., Page.loadEventFired) — include targetId for multi-tab filtering
        const sourceTargetId = msg.params.targetId;
        this.emitProtocolEvent(innerMsg.method, innerMsg.params, { targetId: sourceTargetId });
      }
      return;
    }

    // Outer ack for Target.sendMessageToTarget
    if (msg.id !== undefined) {
      const pending = this.outerPending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.outerPending.delete(msg.id);
        if (msg.error) {
          pending.reject(
            new ProtocolError(
              msg.error.message ?? JSON.stringify(msg.error),
              msg.error.code,
            ),
          );
        }
        // No resolve path — outer ack does not carry the real response
      }
      return;
    }

    // Non-multiplexed event (Target.targetCreated, Target.targetDestroyed, etc.)
    if (msg.method) {
      this.emitProtocolEvent(msg.method, msg.params);
    }
  }

  // ========== Internal Helpers ==========

  clearPendingRequests(): void {
    for (const [, req] of this.outerPending) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Connection closed'));
    }
    this.outerPending.clear();

    for (const [, req] of this.innerPending) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Connection closed'));
    }
    this.innerPending.clear();
  }
}
