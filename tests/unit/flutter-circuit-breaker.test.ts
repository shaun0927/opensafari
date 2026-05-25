/**
 * Unit tests for PR2 — Flutter VM circuit breaker integration.
 *
 * The actual breaker registry lives in `flutter-circuit-breakers.ts`. The
 * client-side wiring (callMethod consults & records into the breaker) is
 * the surface under test.
 */

import { FlutterVMClient, FlutterVMError } from '../../src/flutter/vm-service-client';
import { flutterCircuitBreakers } from '../../src/flutter/flutter-circuit-breakers';

const TEST_DEVICE = 'CB-TEST-DEVICE';

function makeClientWithFakeWs(): FlutterVMClient {
  const client = new FlutterVMClient({ heartbeatIntervalMs: 0 });
  (client as unknown as { ws: unknown }).ws = {
    readyState: 1, // OPEN
    send: () => {/* discard */},
  };
  (client as unknown as { state: Record<string, unknown> }).state = {
    httpUrl: 'http://127.0.0.1:1/x=/',
    wsUrl: 'ws://127.0.0.1:1/x=/ws',
    connected: true,
    deviceId: TEST_DEVICE,
  };
  return client;
}

afterEach(() => {
  flutterCircuitBreakers().get(TEST_DEVICE).reset();
  flutterCircuitBreakers().remove(TEST_DEVICE);
});

describe('FlutterVMClient circuit breaker', () => {
  it('fails fast with CIRCUIT_OPEN when the per-device breaker is open', async () => {
    flutterCircuitBreakers().get(TEST_DEVICE).trip();
    const client = makeClientWithFakeWs();

    await expect(client.callMethod('getVM')).rejects.toMatchObject({
      name: 'FlutterVMError',
      code: 'CIRCUIT_OPEN',
    });
  });

  it('bypasses the breaker when bypassCircuitBreaker: true is set', async () => {
    flutterCircuitBreakers().get(TEST_DEVICE).trip();
    const client = makeClientWithFakeWs();

    // We expect this to NOT throw CIRCUIT_OPEN. It will eventually fail
    // with a timeout because the fake WS never responds — but the timeout
    // proves we got past the breaker gate.
    const pending = client
      .callMethod('getVersion', undefined, { timeoutMs: 50, bypassCircuitBreaker: true })
      .catch((e: Error) => e);

    const err = (await pending) as FlutterVMError;
    expect(err.code).toBe('REQUEST_TIMEOUT');
  });

  it('records failures into the breaker and trips after 3 timeouts', async () => {
    const client = makeClientWithFakeWs();
    const breaker = flutterCircuitBreakers().get(TEST_DEVICE);
    expect(breaker.getState()).toBe('closed');

    for (let i = 0; i < 3; i++) {
      await expect(
        client.callMethod('someMethod', undefined, { timeoutMs: 25 }),
      ).rejects.toThrow();
    }

    expect(breaker.getState()).toBe('open');
  });
});
