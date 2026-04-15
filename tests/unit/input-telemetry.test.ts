/**
 * Unit tests for the input-backend latency telemetry wrapper (issue #502).
 *
 * Covers the three checklist items:
 *   - `timedInput` emits `elapsed_ms > 0` on success
 *   - `timedInput` still emits an event on failure and re-throws
 *   - the emitted event carries `backendKind`, `operation`, `elapsed_ms`, `deviceId`
 *   - structured JSON sink lands on `console.error` in a grep/jq-friendly shape
 */

import {
  timedInput,
  emitInputTelemetry,
  __setInputTelemetrySinkForTest,
  OPENSAFARI_INPUT_TELEMETRY_ENV,
  type InputTelemetryEvent,
} from '../../src/metrics/input-telemetry';

describe('input-telemetry / timedInput', () => {
  let events: InputTelemetryEvent[] = [];

  beforeEach(() => {
    events = [];
    __setInputTelemetrySinkForTest((e) => events.push(e));
  });

  afterEach(() => {
    __setInputTelemetrySinkForTest(null);
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
  });

  test('emits a success event with elapsed_ms >= 0 and required fields', async () => {
    const deviceId = 'UDID-A';
    const result = await timedInput('webkit', 'tap', deviceId, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.backendKind).toBe('webkit');
    expect(ev.operation).toBe('tap');
    expect(ev.deviceId).toBe(deviceId);
    expect(ev.ok).toBe(true);
    expect(typeof ev.elapsed_ms).toBe('number');
    expect(ev.elapsed_ms).toBeGreaterThanOrEqual(0);
    // Sanity: sleep was 5ms so the timing should not be absurdly high.
    expect(ev.elapsed_ms).toBeLessThan(5000);
    expect(ev.error).toBeUndefined();
  });

  test('emits a failure event and re-throws the original error', async () => {
    const boom = new Error('backend exploded');
    const deviceId = 'UDID-B';

    await expect(
      timedInput('simctl', 'swipe', deviceId, async () => {
        await new Promise((r) => setTimeout(r, 2));
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.backendKind).toBe('simctl');
    expect(ev.operation).toBe('swipe');
    expect(ev.deviceId).toBe(deviceId);
    expect(ev.ok).toBe(false);
    expect(ev.error).toBe('backend exploded');
    expect(typeof ev.elapsed_ms).toBe('number');
    expect(ev.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test('stringifies non-Error thrown values into the error field', async () => {
    await expect(
      timedInput('applescript', 'keypress', 'UDID-C', async () => {
        throw 'plain-string-rejection';
      }),
    ).rejects.toBe('plain-string-rejection');

    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
    expect(events[0].error).toBe('plain-string-rejection');
  });

  test('covers every operation label with its backendKind', async () => {
    const ops: Array<InputTelemetryEvent['operation']> = [
      'tap', 'swipe', 'typeText', 'keypress', 'sendKey',
    ];
    for (const op of ops) {
      await timedInput('simhid', op, 'UDID-D', async () => undefined);
    }
    expect(events.map((e) => e.operation)).toEqual(ops);
    expect(events.every((e) => e.backendKind === 'simhid')).toBe(true);
  });

  test('telemetry emission never masks the original error when the sink throws', async () => {
    __setInputTelemetrySinkForTest(() => {
      throw new Error('sink is broken');
    });
    const boom = new Error('backend exploded');
    await expect(
      timedInput('webkit', 'tap', 'UDID-E', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('input-telemetry / console sink', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    __setInputTelemetrySinkForTest(null); // restore default console sink
    spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
  });

  afterEach(() => {
    spy.mockRestore();
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
  });

  test('emits one [input-telemetry] line per event in structured JSON shape', () => {
    emitInputTelemetry({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID-F',
      elapsed_ms: 42,
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line.startsWith('[input-telemetry] ')).toBe(true);
    const payload = JSON.parse(line.slice('[input-telemetry] '.length));
    expect(payload).toEqual({
      backendKind: 'webkit',
      operation: 'tap',
      deviceId: 'UDID-F',
      elapsed_ms: 42,
      ok: true,
    });
  });

  test.each(['0', 'false'])(
    'is silenced when OPENSAFARI_INPUT_TELEMETRY=%s',
    (value) => {
      process.env[OPENSAFARI_INPUT_TELEMETRY_ENV] = value;
      emitInputTelemetry({
        backendKind: 'simctl',
        operation: 'tap',
        deviceId: 'UDID-G',
        elapsed_ms: 1,
        ok: true,
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );
});
