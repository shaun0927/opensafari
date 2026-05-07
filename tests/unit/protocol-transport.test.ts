/**
 * Tests for WebSocketProtocolTransport (#706 2/5).
 *
 * Covers:
 * - send happy path (inner response resolves)
 * - pending-request resolution for out-of-order messages
 * - TimeoutError on stalled inner request
 * - ConnectionError on connection failure
 * - ProtocolError propagated from outer ack error (invalid targetId)
 * - ProtocolError propagated from inner response error
 * - Events emitted for non-multiplexed protocol events
 * - Inner events (domain events) forwarded with targetId metadata
 * - disconnect rejects all pending requests
 */

import { EventEmitter } from 'events';
import { WebSocketProtocolTransport } from '../../src/webkit/protocol-transport';
import { ConnectionError, TimeoutError, ProtocolError } from '../../src/webkit/errors';

// ─── Minimal WebSocket stub ───────────────────────────────────────────────────

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  /** Helper: simulate an inbound raw message from the WebKit proxy. */
  receive(payload: object): void {
    this.emit('message', JSON.stringify(payload));
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build a transport that is already "connected" to a FakeWebSocket. */
function makeConnectedTransport(opts: { sendTimeout?: number } = {}): {
  transport: WebSocketProtocolTransport;
  ws: FakeWebSocket;
} {
  const transport = new WebSocketProtocolTransport({ sendTimeout: opts.sendTimeout ?? 200 });
  const ws = new FakeWebSocket();

  // Inject ws without going through real WebSocket constructor
  (transport as any).ws = ws;
  (transport as any)._connected = true;

  // Wire message routing: transport.handleMessage is private; invoke via ws 'message' event
  ws.on('message', (data: string) => {
    (transport as any).handleMessage(data);
  });

  // Wire close event — mirrors the production handler installed inside
  // `WebSocketProtocolTransport.connect`: flip the connected flag, reject
  // every pending request, then emit the lifecycle event.
  ws.on('close', () => {
    (transport as any)._connected = false;
    (transport as any).clearPendingRequests();
    transport.emit('transport:close');
  });

  return { transport, ws };
}

/** Parse the most recent message sent over the fake WebSocket. */
function lastSent(ws: FakeWebSocket): any {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

/** Simulate a successful dispatchMessageFromTarget response. */
function dispatchResponse(ws: FakeWebSocket, innerId: number, result: unknown): void {
  ws.receive({
    method: 'Target.dispatchMessageFromTarget',
    params: {
      targetId: 'target-1',
      message: JSON.stringify({ id: innerId, result }),
    },
  });
}

/** Simulate a dispatchMessageFromTarget error response. */
function dispatchError(ws: FakeWebSocket, innerId: number, message: string, code?: number): void {
  ws.receive({
    method: 'Target.dispatchMessageFromTarget',
    params: {
      targetId: 'target-1',
      message: JSON.stringify({ id: innerId, error: { message, code } }),
    },
  });
}

/** Simulate an outer ack error (e.g., invalid targetId). */
function outerError(ws: FakeWebSocket, outerId: number, message: string, code?: number): void {
  ws.receive({ id: outerId, error: { message, code } });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocketProtocolTransport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('resolves with result when dispatchMessageFromTarget carries matching innerId', async () => {
    const { transport, ws } = makeConnectedTransport();

    const promise = transport.sendToTarget('Runtime.evaluate', { expression: '1+1' }, 'target-1', 1, 101, 500);

    // Verify wire format
    const sent = lastSent(ws);
    expect(sent.method).toBe('Target.sendMessageToTarget');
    expect(sent.params.targetId).toBe('target-1');
    const inner = JSON.parse(sent.params.message);
    expect(inner.id).toBe(1);
    expect(inner.method).toBe('Runtime.evaluate');

    // Deliver response
    dispatchResponse(ws, 1, { result: { value: 2 } });

    const result = await promise;
    expect(result).toEqual({ result: { value: 2 } });
  });

  // ── Out-of-order resolution ────────────────────────────────────────────────

  it('routes responses to the correct pending request when out of order', async () => {
    const { transport, ws } = makeConnectedTransport();

    const p1 = transport.sendToTarget('Page.navigate', { url: 'https://a.com' }, 'target-1', 10, 201, 500);
    const p2 = transport.sendToTarget('Page.navigate', { url: 'https://b.com' }, 'target-1', 11, 202, 500);

    // Deliver in reverse order
    dispatchResponse(ws, 11, { frameId: 'b' });
    dispatchResponse(ws, 10, { frameId: 'a' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1 as any).frameId).toBe('a');
    expect((r2 as any).frameId).toBe('b');
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  it('rejects with TimeoutError when inner response never arrives', async () => {
    const { transport } = makeConnectedTransport({ sendTimeout: 100 });

    const promise = transport.sendToTarget('Page.navigate', {}, 'target-1', 20, 301, 100);

    jest.advanceTimersByTime(101);

    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('timed out after 100ms') });
  });

  // ── Connection failure ────────────────────────────────────────────────────

  it('rejects immediately with ConnectionError when WebSocket is not open', async () => {
    const transport = new WebSocketProtocolTransport();
    // No ws set — transport not connected

    await expect(
      transport.sendToTarget('Runtime.evaluate', {}, 'target-1', 1, 1, 500),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it('rejects with ConnectionError when connect() times out', async () => {
    const transport = new WebSocketProtocolTransport({ connectTimeout: 50 });

    // connect() opens a real WebSocket — we short-circuit by advancing timers
    // We need a URL that never connects; the timeout fires before 'open'
    const connectPromise = transport.connect('ws://127.0.0.1:19999/devtools/page/never');

    jest.advanceTimersByTime(51);

    await expect(connectPromise).rejects.toBeInstanceOf(ConnectionError);
    await expect(connectPromise).rejects.toMatchObject({ message: expect.stringContaining('timeout') });
  });

  // ── Outer ack error (invalid targetId) ───────────────────────────────────

  it('propagates outer ack ProtocolError to the inner pending promise', async () => {
    const { transport, ws } = makeConnectedTransport();

    const promise = transport.sendToTarget('Runtime.evaluate', {}, 'bad-target', 30, 401, 500);

    outerError(ws, 401, 'No target with given id found', -32000);

    await expect(promise).rejects.toBeInstanceOf(ProtocolError);
    await expect(promise).rejects.toMatchObject({ message: 'No target with given id found', code: -32000 });
  });

  // ── Inner response error ──────────────────────────────────────────────────

  it('rejects with ProtocolError when inner response carries an error', async () => {
    const { transport, ws } = makeConnectedTransport();

    const promise = transport.sendToTarget('Page.unknown', {}, 'target-1', 40, 501, 500);

    dispatchError(ws, 40, "'unknown' was not found", -32601);

    await expect(promise).rejects.toBeInstanceOf(ProtocolError);
    await expect(promise).rejects.toMatchObject({ message: "'unknown' was not found", code: -32601 });
  });

  // ── Non-multiplexed event emission ───────────────────────────────────────

  it('emits non-multiplexed protocol events directly', async () => {
    const { transport, ws } = makeConnectedTransport();

    const received: any[] = [];
    transport.on('Target.targetCreated', (params: any) => received.push(params));

    ws.receive({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'new-target', type: 'page', url: 'about:blank' } },
    });

    expect(received).toHaveLength(1);
    expect(received[0].targetInfo.targetId).toBe('new-target');
  });

  // ── Inner domain event emission ───────────────────────────────────────────

  it('emits inner domain events with targetId metadata', async () => {
    const { transport, ws } = makeConnectedTransport();

    const received: Array<{ params: any; meta: any }> = [];
    transport.on('Page.loadEventFired', (params: any, meta: any) => {
      received.push({ params, meta });
    });

    ws.receive({
      method: 'Target.dispatchMessageFromTarget',
      params: {
        targetId: 'target-1',
        message: JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1234 } }),
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].params).toEqual({ timestamp: 1234 });
    expect(received[0].meta).toEqual({ targetId: 'target-1' });
  });

  // ── disconnect rejects pending ────────────────────────────────────────────

  it('rejects all pending requests with ConnectionError on disconnect()', async () => {
    const { transport } = makeConnectedTransport();

    const p1 = transport.sendToTarget('Runtime.evaluate', {}, 'target-1', 50, 601, 5000);
    const p2 = transport.sendToTarget('Page.navigate', {}, 'target-1', 51, 602, 5000);

    await transport.disconnect();

    await expect(p1).rejects.toBeInstanceOf(ConnectionError);
    await expect(p2).rejects.toBeInstanceOf(ConnectionError);
  });

  // ── isConnected ───────────────────────────────────────────────────────────

  it('returns true when ws is OPEN, false after disconnect', async () => {
    const { transport } = makeConnectedTransport();
    expect(transport.isConnected()).toBe(true);

    await transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  // ── ws close auto-clears pending requests ─────────────────────────────────

  it('rejects pending requests when the underlying socket closes', async () => {
    const { transport, ws } = makeConnectedTransport({ sendTimeout: 10_000 });

    const p1 = transport.sendToTarget('Runtime.evaluate', {}, 'target-1', 60, 701, 10_000);
    const p2 = transport.sendToTarget('Page.navigate', {}, 'target-1', 61, 702, 10_000);

    // Trip ws close without going through transport.disconnect() —
    // pending awaiters should reject immediately rather than wait
    // for their per-request timers to expire.
    ws.close();

    await expect(p1).rejects.toBeInstanceOf(ConnectionError);
    await expect(p2).rejects.toBeInstanceOf(ConnectionError);
  });

  // ── onProtocolEvent subscription ──────────────────────────────────────────

  it('relays raw RDP events via onProtocolEvent without leaking lifecycle events', () => {
    const { transport, ws } = makeConnectedTransport();

    const received: Array<{ event: string; args: unknown[] }> = [];
    const unsubscribe = transport.onProtocolEvent((event, ...args) => {
      received.push({ event, args });
    });

    // Non-multiplexed event
    ws.receive({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 't-1', type: 'page', url: 'about:blank' } },
    });

    // Inner (dispatchMessageFromTarget) event
    ws.receive({
      method: 'Target.dispatchMessageFromTarget',
      params: {
        targetId: 't-1',
        message: JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }),
      },
    });

    // Lifecycle event — must NOT be relayed by onProtocolEvent
    transport.emit('transport:close');

    const events = received.map(r => r.event);
    expect(events).toEqual(['Target.targetCreated', 'Page.loadEventFired']);
    expect(received[1].args[1]).toEqual({ targetId: 't-1' });

    // Unsubscribe stops further deliveries
    unsubscribe();
    ws.receive({
      method: 'Target.targetDestroyed',
      params: { targetId: 't-1' },
    });
    expect(received).toHaveLength(2);
  });
});
