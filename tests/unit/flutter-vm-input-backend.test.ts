/**
 * Unit tests for FlutterVMInputBackend (issue #481).
 *
 * Mocks the FlutterVMClient — we verify the Dart expression shape passed to
 * `evaluate()` without spinning up a real VM. The payload is the contract:
 * tap/swipe/typeText/keypress must each produce a well-formed Dart program
 * that targets PlatformDispatcher / HardwareKeyboard / TextInput.
 */

import {
  FlutterVMInputBackend,
  FlutterVMInputBackendError,
} from '../../src/tools/flutter-vm-input-backend';
import { FlutterVMError } from '../../src/flutter';
import {
  __setInputTelemetrySinkForTest,
  type InputTelemetryEvent,
} from '../../src/metrics/input-telemetry';

const DEVICE = 'TEST-DEVICE-UDID';

/**
 * Build a minimal FlutterVMClient double that records `.evaluate()` calls and
 * returns a healthy VM response by default. Tests override the mock per case.
 */
function makeMockClient() {
  const evaluate = jest
    .fn()
    .mockResolvedValue({ type: '@Instance', kind: 'Bool', valueAsString: 'true' });
  // Mock callMethod('getIsolate', ...) to return all per-operation libraries so
  // resolveLibId() succeeds without a real VM connection.
  const callMethod = jest.fn().mockResolvedValue({
    rootLib: { id: 'libraries/root' },
    libraries: [
      { uri: 'dart:core', id: 'libraries/dart:core' },
      { uri: 'package:flutter/src/rendering/mouse_tracker.dart', id: 'libraries/mouse_tracker' },
      { uri: 'package:flutter/src/widgets/editable_text.dart', id: 'libraries/editable_text' },
      { uri: 'package:flutter/src/services/hardware_keyboard.dart', id: 'libraries/hardware_keyboard' },
    ],
  });
  return {
    evaluate,
    callMethod,
    isConnected: () => true,
    getState: () => ({ mainIsolateId: 'isolates/main' }),
  } as unknown as {
    evaluate: jest.Mock;
    callMethod: jest.Mock;
    isConnected: () => boolean;
    getState: () => { mainIsolateId: string };
  };
}

describe('FlutterVMInputBackend', () => {
  test('exposes kind="flutter-vm" for observability', () => {
    const client = makeMockClient();
    const backend = new FlutterVMInputBackend(client as any);
    expect(backend.kind).toBe('flutter-vm');
  });

  // ── tap() ───────────────────────────────────────────────────────────────

  describe('tap()', () => {
    test('produces a PointerDataPacket with down + up for tap without duration', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.tap(DEVICE, 120, 240);

      expect(client.evaluate).toHaveBeenCalledTimes(1);
      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('PointerDataPacket');
      expect(dart).toContain('PointerChange.down');
      expect(dart).toContain('PointerChange.up');
      expect(dart).toContain('onPointerDataPacket');
      expect(dart).toContain('devicePixelRatio');
      expect(dart).toContain('120');
      expect(dart).toContain('240');
      // duration=0 → up timestamp is `0 * 1000` microseconds
      expect(dart).toContain('0 * 1000');
    });

    test('scales coordinates by implicit view devicePixelRatio', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.tap(DEVICE, 10, 20);
      const dart = client.evaluate.mock.calls[0][0] as string;
      // The Dart expression must multiply logical points by DPR.
      expect(dart).toContain('10 * dpr');
      expect(dart).toContain('20 * dpr');
      expect(dart).toMatch(/view\s*=\s*dispatcher\.implicitView/);
    });

    test('duration > 0 separates up event by duration ms', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.tap(DEVICE, 0, 0, 1.5);
      const dart = client.evaluate.mock.calls[0][0] as string;
      // 1.5s → 1500ms → "1500 * 1000" microseconds.
      expect(dart).toContain('1500 * 1000');
    });

    test('rejects non-finite coordinates before hitting the VM', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await expect(backend.tap(DEVICE, NaN, 0)).rejects.toBeInstanceOf(
        FlutterVMInputBackendError,
      );
      await expect(backend.tap(DEVICE, 0, Infinity)).rejects.toBeInstanceOf(
        FlutterVMInputBackendError,
      );
      // No evaluate() call should have been made for the rejected inputs.
      expect(client.evaluate).not.toHaveBeenCalled();
    });
  });

  // ── swipe() ─────────────────────────────────────────────────────────────

  describe('swipe()', () => {
    test('emits intermediate move events between down and up', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.swipe(DEVICE, 10, 600, 10, 100, 0.5);

      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('PointerChange.down');
      expect(dart).toContain('PointerChange.move');
      expect(dart).toContain('PointerChange.up');
      // Interpolation loop `for (int i = 1; i <= steps; i++)` — default N is 20.
      expect(dart).toContain('for (int i = 1; i <= steps');
      expect(dart).toContain('steps = 20');
    });

    test('uses the provided duration to compute per-step timing', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      // duration=1s, 20 steps → stepUs ≈ 50000 microseconds.
      await backend.swipe(DEVICE, 0, 0, 100, 100, 1);
      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('stepUs = 50000');
    });

    test('defaults to 500ms duration when omitted', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.swipe(DEVICE, 0, 0, 100, 100);
      const dart = client.evaluate.mock.calls[0][0] as string;
      // 500ms / 20 steps = 25000us
      expect(dart).toContain('stepUs = 25000');
    });
  });

  // ── typeText() ──────────────────────────────────────────────────────────

  describe('typeText()', () => {
    test('invokes TextInput.updateEditingState via platform message', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.typeText(DEVICE, 'hello');

      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('flutter/textinput');
      expect(dart).toContain('TextInputClient.updateEditingState');
      expect(dart).toContain('JSONMethodCodec');
      expect(dart).toContain('selectionBase');
    });

    test('encodes text as fromCharCodes to avoid Dart string escaping pitfalls', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.typeText(DEVICE, "say 'hi' $100");
      const dart = client.evaluate.mock.calls[0][0] as string;
      // `s` is 0x73, `a` is 0x61, `y` is 0x79 …
      expect(dart).toContain('String.fromCharCodes(const [');
      expect(dart).toContain('115,97,121'); // 's', 'a', 'y'
      // No raw dollar sign that would trigger Dart interpolation.
      expect(dart).not.toContain("'say 'hi'");
    });
  });

  // ── keypress() / sendKey() ──────────────────────────────────────────────

  describe('keypress()', () => {
    test('maps Enter (HID 40) to LogicalKeyboardKey.enter and dispatches KeyDown+KeyUp', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.keypress(DEVICE, '40');

      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('LogicalKeyboardKey.enter');
      expect(dart).toContain('KeyDownEvent');
      expect(dart).toContain('KeyUpEvent');
      expect(dart).toContain('HardwareKeyboard.instance.handleKeyEvent');
    });

    test('throws for unknown HID code', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);
      await expect(backend.keypress(DEVICE, '999')).rejects.toThrow(
        'Unknown HID key code "999"',
      );
      expect(client.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('sendKey()', () => {
    test('maps "Return" to LogicalKeyboardKey.enter', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.sendKey(DEVICE, 'Return');
      const dart = client.evaluate.mock.calls[0][0] as string;
      expect(dart).toContain('LogicalKeyboardKey.enter');
    });

    test('throws for unknown key name', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);
      await expect(backend.sendKey(DEVICE, 'MegaKey')).rejects.toThrow(
        'Unknown key name "MegaKey"',
      );
    });
  });

  // ── error translation ──────────────────────────────────────────────────

  describe('error handling', () => {
    test('wraps VM Service errors in FlutterVMInputBackendError', async () => {
      const client = makeMockClient();
      client.evaluate.mockRejectedValueOnce(
        new FlutterVMError('socket closed', 'DISCONNECTED'),
      );
      const backend = new FlutterVMInputBackend(client as any);

      try {
        await backend.tap(DEVICE, 10, 20);
        fail('expected FlutterVMInputBackendError');
      } catch (err) {
        expect(err).toBeInstanceOf(FlutterVMInputBackendError);
        const e = err as FlutterVMInputBackendError;
        expect(e.op).toBe('tap');
        expect(e.cause).toBeInstanceOf(FlutterVMError);
      }
    });

    test('Dart-side error responses surface as FlutterVMInputBackendError', async () => {
      const client = makeMockClient();
      client.evaluate.mockResolvedValueOnce({
        type: '@Error',
        message: 'Undefined name',
      });
      const backend = new FlutterVMInputBackend(client as any);

      await expect(backend.tap(DEVICE, 1, 2)).rejects.toBeInstanceOf(
        FlutterVMInputBackendError,
      );
    });

    test('error op is typeText when typeText fails', async () => {
      const client = makeMockClient();
      client.evaluate.mockRejectedValueOnce(new Error('boom'));
      const backend = new FlutterVMInputBackend(client as any);

      try {
        await backend.typeText(DEVICE, 'x');
        fail('expected error');
      } catch (err) {
        expect((err as FlutterVMInputBackendError).op).toBe('typeText');
      }
    });
  });

  // ── telemetry (#502) ─────────────────────────────────────────────────────

  describe('telemetry', () => {
    let events: InputTelemetryEvent[];

    beforeEach(() => {
      events = [];
      __setInputTelemetrySinkForTest((e) => events.push(e));
    });

    afterEach(() => {
      __setInputTelemetrySinkForTest(null);
    });

    test('tap emits one flutter-vm telemetry event with the device id', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.tap(DEVICE, 10, 20);

      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.backendKind).toBe('flutter-vm');
      expect(ev.operation).toBe('tap');
      expect(ev.deviceId).toBe(DEVICE);
      expect(ev.ok).toBe(true);
      expect(ev.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    test('swipe / typeText / keypress / sendKey all emit with the right operation label', async () => {
      const client = makeMockClient();
      const backend = new FlutterVMInputBackend(client as any);

      await backend.swipe(DEVICE, 10, 10, 20, 20);
      await backend.typeText(DEVICE, 'hello');
      await backend.keypress(DEVICE, '40'); // Enter
      await backend.sendKey(DEVICE, 'Tab');

      expect(events.map((e) => e.operation)).toEqual([
        'swipe', 'typeText', 'keypress', 'sendKey',
      ]);
      expect(events.every((e) => e.backendKind === 'flutter-vm')).toBe(true);
      expect(events.every((e) => e.deviceId === DEVICE && e.ok === true)).toBe(true);
    });

    test('failure still emits an event with ok=false before re-throwing', async () => {
      const client = makeMockClient();
      client.evaluate.mockRejectedValueOnce(new Error('dart boom'));
      const backend = new FlutterVMInputBackend(client as any);

      await expect(backend.tap(DEVICE, 1, 2)).rejects.toBeInstanceOf(
        FlutterVMInputBackendError,
      );
      expect(events).toHaveLength(1);
      expect(events[0].ok).toBe(false);
      expect(events[0].operation).toBe('tap');
      expect(events[0].error).toMatch(/dart boom/);
    });
  });
});
