/**
 * WebKitClient heartbeat policy.
 *
 * A single failed probe must not tear down the connection: page JS can be
 * busy past the send timeout, and the active target is briefly absent during
 * navigation. Disconnect handling fires only after N consecutive failures,
 * and reconnect must not implicitly reload the page unless opted in.
 */
import { WebKitClient, WebKitClientOptions } from '../../src/webkit/client';

const HEARTBEAT_MS = 1_000;

function makeClient(options?: Partial<WebKitClientOptions>): WebKitClient {
  return new WebKitClient({
    host: 'localhost',
    port: 59999,
    heartbeatInterval: HEARTBEAT_MS,
    ...options,
  });
}

function startHeartbeat(client: WebKitClient): void {
  (client as unknown as { startHeartbeat(): void }).startHeartbeat();
}

function stopHeartbeat(client: WebKitClient): void {
  (client as unknown as { stopHeartbeat(): void }).stopHeartbeat();
}

describe('WebKitClient heartbeat failure threshold', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('failures below the threshold do not disconnect', async () => {
    const client = makeClient();
    jest.spyOn(client, 'send').mockRejectedValue(new Error('probe timeout'));
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    (client as any).handleDisconnect = disconnectSpy;

    startHeartbeat(client);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2); // 2 failures < 3
    stopHeartbeat(client);

    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  test('reaching the threshold disconnects exactly once', async () => {
    const client = makeClient();
    jest.spyOn(client, 'send').mockRejectedValue(new Error('probe timeout'));
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    (client as any).handleDisconnect = disconnectSpy;

    startHeartbeat(client);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 3); // 3 consecutive failures
    stopHeartbeat(client);

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  test('a successful probe resets the consecutive-failure counter', async () => {
    const client = makeClient();
    const sendSpy = jest
      .spyOn(client, 'send')
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(1 as never)
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockRejectedValueOnce(new Error('fail 4'));
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    (client as any).handleDisconnect = disconnectSpy;

    startHeartbeat(client);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 5); // fail,fail,ok,fail,fail
    stopHeartbeat(client);

    expect(sendSpy).toHaveBeenCalledTimes(5);
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  test('heartbeatFailureThreshold option overrides the default', async () => {
    const client = makeClient({ heartbeatFailureThreshold: 1 });
    jest.spyOn(client, 'send').mockRejectedValue(new Error('probe timeout'));
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    (client as any).handleDisconnect = disconnectSpy;

    startHeartbeat(client);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    stopHeartbeat(client);

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('WebKitClient reconnect re-navigation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function runHandleDisconnect(client: WebKitClient): Promise<void> {
    jest.spyOn(client, 'connect').mockResolvedValue(undefined);
    const promise = (client as any).handleDisconnect() as Promise<void>;
    // Skip past the first reconnect backoff delay (base 1s + jitter).
    await jest.advanceTimersByTimeAsync(5_000);
    await promise;
  }

  test('does not re-navigate by default', async () => {
    const client = makeClient();
    (client as any).lastUrl = 'https://example.com/state';
    const navigateSpy = jest.spyOn(client, 'navigate').mockResolvedValue({} as never);

    await runHandleDisconnect(client);

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test('re-navigates when renavigateOnReconnect is enabled', async () => {
    const client = makeClient({ renavigateOnReconnect: true });
    (client as any).lastUrl = 'https://example.com/state';
    const navigateSpy = jest.spyOn(client, 'navigate').mockResolvedValue({} as never);

    await runHandleDisconnect(client);

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith({ url: 'https://example.com/state' });
  });

  test('handleDisconnect resolves even when transport teardown rejects', async () => {
    const client = makeClient();
    const transport = (client as any).transport;
    jest.spyOn(transport, 'disconnect').mockRejectedValue(new Error('teardown boom'));
    jest.spyOn(client, 'connect').mockResolvedValue(undefined);

    const promise = (client as any).handleDisconnect() as Promise<void>;
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBeUndefined();
  });
});
