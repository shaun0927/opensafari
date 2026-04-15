/**
 * Unit tests for runInputOp + buildInputMeta's opt-in `_telemetry` projection
 * (Phase 2 of issue #502).
 */

import {
  buildInputMeta,
  runInputOp,
  OPENSAFARI_INPUT_TELEMETRY_META_ENV,
} from '../../src/tools/native-input-utils';
import {
  timedInput,
  __setInputTelemetrySinkForTest,
  OPENSAFARI_INPUT_TELEMETRY_ENV,
} from '../../src/metrics/input-telemetry';
import type { InputBackend } from '../../src/tools/native-input-backend';

function makeBackend(kind: InputBackend['kind']): InputBackend {
  return {
    kind,
    async tap(deviceId, x, y, duration) {
      await timedInput(kind, 'tap', deviceId, async () => {
        // Simulate some work so elapsed_ms > 0 occasionally.
        await new Promise((r) => setTimeout(r, 1));
        void x; void y; void duration;
      });
    },
    async swipe(deviceId) {
      await timedInput(kind, 'swipe', deviceId, async () => undefined);
    },
    async typeText(deviceId) {
      await timedInput(kind, 'typeText', deviceId, async () => undefined);
    },
    async keypress(deviceId) {
      await timedInput(kind, 'keypress', deviceId, async () => undefined);
    },
    async sendKey(deviceId) {
      await timedInput(kind, 'sendKey', deviceId, async () => undefined);
    },
  };
}

describe('runInputOp', () => {
  beforeEach(() => {
    // Silence the default console sink for determinism.
    process.env[OPENSAFARI_INPUT_TELEMETRY_ENV] = '0';
  });

  afterEach(() => {
    __setInputTelemetrySinkForTest(null);
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_ENV];
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV];
  });

  test('omits _telemetry from meta by default (opt-in not set)', async () => {
    const backend = makeBackend('webkit');
    const { meta } = await runInputOp(backend, 'UDID', () =>
      backend.tap('UDID', 10, 20),
    );
    expect(meta.backendKind).toBe('webkit');
    expect(meta.headless).toBe(true);
    expect(meta.deviceId).toBe('UDID');
    expect(meta._telemetry).toBeUndefined();
  });

  test('attaches _telemetry projection when OPENSAFARI_INPUT_TELEMETRY_META=1', async () => {
    process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV] = '1';
    const backend = makeBackend('webkit');
    const { meta } = await runInputOp(backend, 'UDID', () =>
      backend.tap('UDID', 10, 20),
    );
    expect(Array.isArray(meta._telemetry)).toBe(true);
    expect(meta._telemetry).toHaveLength(1);
    const t = meta._telemetry![0];
    expect(t.operation).toBe('tap');
    expect(t.ok).toBe(true);
    expect(typeof t.elapsed_ms).toBe('number');
    expect(t.elapsed_ms).toBeGreaterThanOrEqual(0);
    // Compact projection: deviceId / backendKind omitted (carried by parent).
    expect((t as unknown as Record<string, unknown>).deviceId).toBeUndefined();
    expect((t as unknown as Record<string, unknown>).backendKind).toBeUndefined();
  });

  test('captures multi-call operations (tap + typeText) in a single scope', async () => {
    process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV] = '1';
    const backend = makeBackend('simctl');
    const { meta } = await runInputOp(backend, 'UDID', async () => {
      await backend.tap('UDID', 5, 5);
      await backend.typeText('UDID', 'hi');
    });
    expect(meta._telemetry!.map((t) => t.operation)).toEqual([
      'tap',
      'typeText',
    ]);
  });

  test('records ok=false and error on failure, re-throws original', async () => {
    process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV] = '1';
    const backend = makeBackend('webkit');
    // Swap tap for a failing op
    backend.tap = async (deviceId) => {
      await timedInput('webkit', 'tap', deviceId, async () => {
        throw new Error('boom');
      });
    };
    await expect(
      runInputOp(backend, 'UDID', () => backend.tap('UDID', 1, 2)),
    ).rejects.toThrow('boom');
  });

  test('headless is false only for applescript backend', () => {
    expect(buildInputMeta(makeBackend('applescript'), 'D').headless).toBe(false);
    expect(buildInputMeta(makeBackend('webkit'), 'D').headless).toBe(true);
    expect(buildInputMeta(makeBackend('simctl'), 'D').headless).toBe(true);
    expect(buildInputMeta(makeBackend('simhid'), 'D').headless).toBe(true);
    expect(buildInputMeta(makeBackend('flutter-vm'), 'D').headless).toBe(true);
  });

  test('buildInputMeta ignores telemetry events when opt-in is off', () => {
    delete process.env[OPENSAFARI_INPUT_TELEMETRY_META_ENV];
    const backend = makeBackend('webkit');
    const meta = buildInputMeta(backend, 'UDID', [
      {
        backendKind: 'webkit',
        operation: 'tap',
        deviceId: 'UDID',
        elapsed_ms: 7,
        ok: true,
      },
    ]);
    expect(meta._telemetry).toBeUndefined();
  });
});
