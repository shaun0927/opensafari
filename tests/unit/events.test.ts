/**
 * Tests for EventBridge (#706 5/5).
 *
 * Covers:
 * - transport domain events are forwarded to host EventEmitter (Page.loadEventFired, etc.)
 * - target:created payload forwarded from TargetSessionManager → host
 * - target:destroyed payload forwarded from TargetSessionManager → host
 * - onConsole translates Console.messageAdded → ConsoleMessage (typed shape)
 * - onRequest translates Network.requestWillBeSent → RequestInfo (typed shape)
 * - onResponse translates Network.responseReceived → ResponseInfo (typed shape)
 * - onPageLoad attaches Page.loadEventFired listener
 * - onError translates Console.messageAdded (level=error, source=javascript) → ErrorInfo
 * - onError ignores non-error Console.messageAdded events
 * - transport:close / transport:error are NOT forwarded to host
 * - newListener / removeListener are NOT forwarded to host
 * - payload shapes are TypeScript-typed (compile-time evidence via interface assignment)
 */

import { EventEmitter } from 'events';
import { EventBridge } from '../../src/webkit/events';
import type {
  TargetCreatedPayload,
  TargetDestroyedPayload,
  ConsoleMessage,
  RequestInfo,
  ResponseInfo,
  ErrorInfo,
  EventBridgeHost,
} from '../../src/webkit/events';
import type { ProtocolTransport } from '../../src/webkit/protocol-transport';

// ─── Minimal transport stub ───────────────────────────────────────────────────

class FakeTransport extends EventEmitter implements ProtocolTransport {
  connect(_wsUrl: string): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  isConnected(): boolean { return true; }
  sendToTarget<T>(): Promise<T> { return Promise.resolve({} as T); }
  onProtocolEvent(): () => void { return () => {}; }
}

// ─── Minimal host stub ───────────────────────────────────────────────────────

class FakeHost extends EventEmitter implements EventBridgeHost {
  enabledDomains: string[] = [];

  async enableDomain(domain: string): Promise<void> {
    this.enabledDomains.push(domain);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSetup(): {
  transport: FakeTransport;
  targetSession: EventEmitter;
  host: FakeHost;
  bridge: EventBridge;
} {
  const transport = new FakeTransport();
  const targetSession = new EventEmitter();
  const host = new FakeHost();
  const bridge = new EventBridge(transport, targetSession, host as any);
  bridge.attach();
  return { transport, targetSession, host, bridge };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EventBridge — transport forwarding', () => {
  it('forwards domain events (Page.loadEventFired) to host', () => {
    const { transport, host } = makeSetup();
    const received: any[] = [];
    host.on('Page.loadEventFired', (params: any) => received.push(params));

    transport.emit('Page.loadEventFired', { timestamp: 1234 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ timestamp: 1234 });
  });

  it('forwards Network.requestWillBeSent to host', () => {
    const { transport, host } = makeSetup();
    const received: any[] = [];
    host.on('Network.requestWillBeSent', (p: any) => received.push(p));

    transport.emit('Network.requestWillBeSent', { request: { url: 'https://example.com', method: 'GET' } });

    expect(received).toHaveLength(1);
    expect(received[0].request.url).toBe('https://example.com');
  });

  it('does NOT forward transport:close to host', () => {
    const { transport, host } = makeSetup();
    const received: any[] = [];
    host.on('transport:close', () => received.push(true));

    transport.emit('transport:close');

    expect(received).toHaveLength(0);
  });

  it('does NOT forward transport:error to host', () => {
    const { transport, host } = makeSetup();
    const received: any[] = [];
    host.on('transport:error', () => received.push(true));
    // Prevent unhandled error on FakeTransport
    transport.on('error', () => {});

    transport.emit('transport:error', new Error('boom'));

    expect(received).toHaveLength(0);
  });

  it('does NOT forward newListener / removeListener from transport to host domain listeners', () => {
    const { transport, host } = makeSetup();
    // Count domain-specific events on host emitted AFTER setup.
    // We track whether 'newListener' or 'removeListener' are forwarded as named events
    // by checking the host's event emission via a spy on a specific harmless event name.
    // (Registering `host.on('newListener', cb)` itself fires newListener on host, so we
    //  cannot use that approach. Instead, verify the forwarded event list excludes them.)
    const forwardedEvents: string[] = [];
    const origEmit = EventEmitter.prototype.emit.bind(host);
    (host as any).emit = (event: string, ...args: any[]) => {
      forwardedEvents.push(event);
      return origEmit(event, ...args);
    };

    // Trigger newListener / removeListener on transport (not domain events)
    transport.on('foo', () => {});
    transport.removeAllListeners('foo');

    expect(forwardedEvents).not.toContain('newListener');
    expect(forwardedEvents).not.toContain('removeListener');
  });
});

describe('EventBridge — target lifecycle forwarding', () => {
  it('forwards target:created from TargetSessionManager to host with correct shape', () => {
    const { targetSession, host } = makeSetup();
    const received: TargetCreatedPayload[] = [];
    host.on('target:created', (p: TargetCreatedPayload) => received.push(p));

    targetSession.emit('target:created', { targetId: 'abc', url: 'https://a.com' });

    expect(received).toHaveLength(1);
    // Type-safe field access — compile error if shape is wrong
    const payload: TargetCreatedPayload = received[0];
    expect(payload.targetId).toBe('abc');
    expect(payload.url).toBe('https://a.com');
  });

  it('forwards target:destroyed from TargetSessionManager to host with correct shape', () => {
    const { targetSession, host } = makeSetup();
    const received: TargetDestroyedPayload[] = [];
    host.on('target:destroyed', (p: TargetDestroyedPayload) => received.push(p));

    targetSession.emit('target:destroyed', { targetId: 'xyz' });

    expect(received).toHaveLength(1);
    const payload: TargetDestroyedPayload = received[0];
    expect(payload.targetId).toBe('xyz');
  });
});

describe('EventBridge — typed convenience listeners', () => {
  it('onConsole: enables Console domain and translates Console.messageAdded to ConsoleMessage', async () => {
    const { host, bridge } = makeSetup();
    const received: ConsoleMessage[] = [];

    bridge.onConsole((msg: ConsoleMessage) => received.push(msg));
    // enableDomain is async; flush microtasks
    await Promise.resolve();

    expect(host.enabledDomains).toContain('Console');

    host.emit('Console.messageAdded', { message: { level: 'warning', text: 'test warning' } });

    expect(received).toHaveLength(1);
    // Type-safe field access
    const msg: ConsoleMessage = received[0];
    expect(msg.type).toBe('warning');
    expect(msg.text).toBe('test warning');
  });

  it('onConsole: uses "log" as fallback type when level and type are absent', async () => {
    const { host, bridge } = makeSetup();
    const received: ConsoleMessage[] = [];
    bridge.onConsole((msg) => received.push(msg));
    await Promise.resolve();

    host.emit('Console.messageAdded', { message: { text: 'hello' } });

    expect(received[0].type).toBe('log');
    expect(received[0].text).toBe('hello');
  });

  it('onPageLoad: enables Page domain and attaches Page.loadEventFired listener', async () => {
    const { host, bridge } = makeSetup();
    let fired = false;

    bridge.onPageLoad(() => { fired = true; });
    await Promise.resolve();

    expect(host.enabledDomains).toContain('Page');
    host.emit('Page.loadEventFired');
    expect(fired).toBe(true);
  });

  it('onRequest: enables Network domain and translates Network.requestWillBeSent to RequestInfo', async () => {
    const { host, bridge } = makeSetup();
    const received: RequestInfo[] = [];

    bridge.onRequest((req: RequestInfo) => received.push(req));
    await Promise.resolve();

    expect(host.enabledDomains).toContain('Network');
    host.emit('Network.requestWillBeSent', { request: { url: 'https://api.example.com', method: 'POST' } });

    expect(received).toHaveLength(1);
    const req: RequestInfo = received[0];
    expect(req.url).toBe('https://api.example.com');
    expect(req.method).toBe('POST');
  });

  it('onRequest: defaults method to GET when absent', async () => {
    const { host, bridge } = makeSetup();
    const received: RequestInfo[] = [];
    bridge.onRequest((req) => received.push(req));
    await Promise.resolve();

    host.emit('Network.requestWillBeSent', { request: { url: 'https://x.com' } });

    expect(received[0].method).toBe('GET');
  });

  it('onResponse: enables Network domain and translates Network.responseReceived to ResponseInfo', async () => {
    const { host, bridge } = makeSetup();
    const received: ResponseInfo[] = [];

    bridge.onResponse((res: ResponseInfo) => received.push(res));
    await Promise.resolve();

    expect(host.enabledDomains).toContain('Network');
    host.emit('Network.responseReceived', { response: { url: 'https://api.example.com', status: 200 } });

    expect(received).toHaveLength(1);
    const res: ResponseInfo = received[0];
    expect(res.url).toBe('https://api.example.com');
    expect(res.status).toBe(200);
  });

  it('onResponse: defaults status to 0 when absent', async () => {
    const { host, bridge } = makeSetup();
    const received: ResponseInfo[] = [];
    bridge.onResponse((res) => received.push(res));
    await Promise.resolve();

    host.emit('Network.responseReceived', { response: { url: 'https://x.com' } });

    expect(received[0].status).toBe(0);
  });

  it('onError: enables Console domain, translates JS error Console.messageAdded to ErrorInfo', async () => {
    const { host, bridge } = makeSetup();
    const received: ErrorInfo[] = [];

    bridge.onError((err: ErrorInfo) => received.push(err));
    await Promise.resolve();

    expect(host.enabledDomains).toContain('Console');

    host.emit('Console.messageAdded', {
      message: {
        level: 'error',
        source: 'javascript',
        text: 'Uncaught TypeError: foo is not a function',
        url: 'https://example.com/app.js',
        line: 42,
        column: 7,
        stackTrace: {
          callFrames: [
            { functionName: 'handleClick', url: 'https://example.com/app.js', lineNumber: 42, columnNumber: 7 },
          ],
        },
      },
    });

    expect(received).toHaveLength(1);
    const err: ErrorInfo = received[0];
    expect(err.message).toBe('Uncaught TypeError: foo is not a function');
    expect(err.source).toBe('https://example.com/app.js');
    expect(err.line).toBe(42);
    expect(err.column).toBe(7);
    expect(err.stack).toContain('handleClick');
  });

  it('onError: ignores Console.messageAdded events that are not JS errors', async () => {
    const { host, bridge } = makeSetup();
    const received: ErrorInfo[] = [];
    bridge.onError((err) => received.push(err));
    await Promise.resolve();

    // Non-error level
    host.emit('Console.messageAdded', { message: { level: 'log', source: 'javascript', text: 'just a log' } });
    // Error level but not javascript source
    host.emit('Console.messageAdded', { message: { level: 'error', source: 'network', text: 'net error' } });

    expect(received).toHaveLength(0);
  });

  it('onError: produces ErrorInfo with no stack when callFrames is empty', async () => {
    const { host, bridge } = makeSetup();
    const received: ErrorInfo[] = [];
    bridge.onError((err) => received.push(err));
    await Promise.resolve();

    host.emit('Console.messageAdded', {
      message: {
        level: 'error',
        source: 'javascript',
        text: 'bare error',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].stack).toBeUndefined();
  });
});
