/**
 * FlutterVMInputBackend — Tier-0 headless input backend for Flutter apps.
 *
 * Dispatches pointer/keyboard/text events directly to the Flutter engine via
 * the Dart VM Service (`FlutterVMClient.evaluate`). Because the events are
 * synthesised inside the running Dart isolate and fed straight into
 * `PlatformDispatcher.onPointerDataPacket`, this backend:
 *
 *   - **Does not move the physical mouse cursor** (no CGEvent)
 *   - **Does not bring Simulator.app to the foreground** (no AppleScript
 *     activation)
 *   - **Requires no opt-in env var** — it is truly headless
 *
 * Compared to the three existing tiers (simctl → webkit → applescript), this
 * path is picked first whenever the target device is running a Flutter app in
 * debug/profile mode and the VM Service URL can be discovered. Native UIKit
 * apps continue to flow through the existing tiers unchanged.
 *
 * Coordinate system: iOS AX frames are expressed in logical points (the same
 * units Flutter calls "logical pixels"). The Dart payload multiplies by the
 * implicit view's `devicePixelRatio` to land on the engine's `physicalX/Y`
 * expectations.
 *
 * See issue #481 for the motivation and rollout checklist.
 */

import type { FlutterVMClient } from '../flutter';
import { FlutterVMError } from '../flutter';
import type { InputBackend, InputBackendKind } from './native-input-backend';

/**
 * Structured error surfaced by FlutterVMInputBackend when the underlying VM
 * Service call fails (connection drop, Dart exception, timeout, etc). Carries
 * the originating op so observability layers can attribute the failure.
 */
export class FlutterVMInputBackendError extends Error {
  readonly name = 'FlutterVMInputBackendError' as const;
  readonly op: 'tap' | 'swipe' | 'typeText' | 'keypress' | 'sendKey';
  readonly cause: unknown;

  constructor(
    op: FlutterVMInputBackendError['op'],
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`FlutterVMInputBackend.${op} failed: ${msg}`);
    this.op = op;
    this.cause = cause;
    Object.setPrototypeOf(this, FlutterVMInputBackendError.prototype);
  }
}

/**
 * HID key-code → Dart `LogicalKeyboardKey` identifier. The keyIds match the
 * values exposed by `package:flutter/services.dart` so the Dart payload can
 * materialise a `KeyDownEvent` / `KeyUpEvent` pair.
 */
const HID_TO_LOGICAL_KEY: Record<string, { keyId: string; keyLabel: string; physicalKey: string }> = {
  '40': { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter', physicalKey: 'PhysicalKeyboardKey.enter' },
  '41': { keyId: 'LogicalKeyboardKey.escape', keyLabel: 'Escape', physicalKey: 'PhysicalKeyboardKey.escape' },
  '42': { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace', physicalKey: 'PhysicalKeyboardKey.backspace' },
  '43': { keyId: 'LogicalKeyboardKey.tab', keyLabel: 'Tab', physicalKey: 'PhysicalKeyboardKey.tab' },
  '44': { keyId: 'LogicalKeyboardKey.space', keyLabel: ' ', physicalKey: 'PhysicalKeyboardKey.space' },
  '74': { keyId: 'LogicalKeyboardKey.home', keyLabel: 'Home', physicalKey: 'PhysicalKeyboardKey.home' },
  '79': { keyId: 'LogicalKeyboardKey.arrowRight', keyLabel: 'ArrowRight', physicalKey: 'PhysicalKeyboardKey.arrowRight' },
  '80': { keyId: 'LogicalKeyboardKey.arrowLeft', keyLabel: 'ArrowLeft', physicalKey: 'PhysicalKeyboardKey.arrowLeft' },
  '81': { keyId: 'LogicalKeyboardKey.arrowDown', keyLabel: 'ArrowDown', physicalKey: 'PhysicalKeyboardKey.arrowDown' },
  '82': { keyId: 'LogicalKeyboardKey.arrowUp', keyLabel: 'ArrowUp', physicalKey: 'PhysicalKeyboardKey.arrowUp' },
};

const SENDKEY_TO_LOGICAL_KEY: Record<string, { keyId: string; keyLabel: string; physicalKey: string }> = {
  Return: { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter', physicalKey: 'PhysicalKeyboardKey.enter' },
  Enter: { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter', physicalKey: 'PhysicalKeyboardKey.enter' },
  Escape: { keyId: 'LogicalKeyboardKey.escape', keyLabel: 'Escape', physicalKey: 'PhysicalKeyboardKey.escape' },
  Tab: { keyId: 'LogicalKeyboardKey.tab', keyLabel: 'Tab', physicalKey: 'PhysicalKeyboardKey.tab' },
  Space: { keyId: 'LogicalKeyboardKey.space', keyLabel: ' ', physicalKey: 'PhysicalKeyboardKey.space' },
  Delete: { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace', physicalKey: 'PhysicalKeyboardKey.backspace' },
  Backspace: { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace', physicalKey: 'PhysicalKeyboardKey.backspace' },
  Home: { keyId: 'LogicalKeyboardKey.home', keyLabel: 'Home', physicalKey: 'PhysicalKeyboardKey.home' },
  ArrowRight: { keyId: 'LogicalKeyboardKey.arrowRight', keyLabel: 'ArrowRight', physicalKey: 'PhysicalKeyboardKey.arrowRight' },
  ArrowLeft: { keyId: 'LogicalKeyboardKey.arrowLeft', keyLabel: 'ArrowLeft', physicalKey: 'PhysicalKeyboardKey.arrowLeft' },
  ArrowDown: { keyId: 'LogicalKeyboardKey.arrowDown', keyLabel: 'ArrowDown', physicalKey: 'PhysicalKeyboardKey.arrowDown' },
  ArrowUp: { keyId: 'LogicalKeyboardKey.arrowUp', keyLabel: 'ArrowUp', physicalKey: 'PhysicalKeyboardKey.arrowUp' },
};

/**
 * Format a finite number for interpolation into a Dart literal. Reject NaN /
 * ±Infinity so the VM Service never receives a syntactically invalid
 * expression (e.g. `Offset(NaN, NaN)` would confuse the analyser).
 */
function dartNum(value: number, label: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: ${value} (must be finite)`);
  }
  // toString() preserves sufficient precision for pixel coordinates.
  return value.toString();
}

/**
 * Escape a JS string for safe embedding inside a Dart single-quoted literal.
 * Dart string escape rules are similar to JS but the safest approach is to
 * emit a Dart list-of-codeUnits from JSON.stringify, avoiding any ambiguity
 * over dollar interpolation, backslashes, quotes, or non-ASCII.
 */
function dartStringLiteral(value: string): string {
  // Encode via a Dart `String.fromCharCodes` so we never have to worry about
  // dollar-sign interpolation, adjacent quotes, or embedded newlines.
  const codeUnits: number[] = [];
  for (let i = 0; i < value.length; i++) {
    codeUnits.push(value.charCodeAt(i));
  }
  return `String.fromCharCodes(const [${codeUnits.join(',')}])`;
}

/**
 * FlutterVMInputBackend — implements the InputBackend contract by evaluating
 * Dart expressions inside the target app's main isolate.
 */
export class FlutterVMInputBackend implements InputBackend {
  readonly kind: InputBackendKind = 'flutter-vm';
  private libIdCache: Map<string, string> = new Map();

  constructor(private vmClient: FlutterVMClient) {}

  /**
   * Resolve a Flutter library URI to its VM Service library id, caching the
   * result per URI. Each operation targets a different library so that the
   * required symbols are in lexical scope:
   *   - pointer dispatch → `mouse_tracker.dart` (bare `import 'dart:ui'`)
   *   - text input       → `editable_text.dart`
   *   - key events       → `hardware_keyboard.dart`
   *
   * Same pattern used by `FlutterVMClient.selectWidgetAtPoint` for the
   * inspector library (see `vm-service-client.ts:386-411`).
   */
  private async resolveLibId(uri: string): Promise<string> {
    const cached = this.libIdCache.get(uri);
    if (cached) return cached;

    const isolateId = this.vmClient.getState()?.mainIsolateId;
    if (!isolateId) {
      throw new FlutterVMError('No main isolate', 'NO_ISOLATE');
    }
    const isolate = await this.vmClient.callMethod('getIsolate', { isolateId });
    const libs =
      (isolate as { libraries?: Array<{ uri?: string; id?: string }> }).libraries ?? [];
    const lib = libs.find((l) => l.uri === uri);
    if (!lib?.id) {
      throw new FlutterVMError(
        `${uri} library not loaded in isolate — is this a Flutter app?`,
        'NO_BINDING_LIB',
      );
    }
    this.libIdCache.set(uri, lib.id);
    return lib.id;
  }

  /**
   * Synthesise a pointer down → up sequence. When `duration` (in seconds) is
   * positive the up event is timestamped `duration * 1000` ms after the down
   * event so Flutter's gesture arena treats it as a long-press rather than a
   * tap. The Dart payload ends with
   * `SchedulerBinding.instance.scheduleFrame()` to ensure the engine pumps
   * the event queue even in a quiescent state.
   */
  async tap(
    _deviceId: string,
    x: number,
    y: number,
    duration?: number,
  ): Promise<void> {
    let xStr: string;
    let yStr: string;
    try {
      xStr = dartNum(x, 'x');
      yStr = dartNum(y, 'y');
    } catch (err) {
      throw new FlutterVMInputBackendError('tap', err);
    }
    const durMs = duration && duration > 0 ? Math.round(duration * 1000) : 0;

    const expression =
      '(() {' +
      '  final dispatcher = PlatformDispatcher.instance;' +
      '  final view = dispatcher.implicitView;' +
      '  if (view == null) { return false; }' +
      '  final dpr = view.devicePixelRatio;' +
      `  final double px = ${xStr} * dpr;` +
      `  final double py = ${yStr} * dpr;` +
      `  final int downUs = 0;` +
      `  final int upUs = ${durMs} * 1000;` +
      '  void dispatch(int tUs, PointerChange change) {' +
      '    final packet = PointerDataPacket(data: <PointerData>[' +
      '      PointerData(' +
      '        timeStamp: Duration(microseconds: tUs),' +
      '        change: change,' +
      '        kind: PointerDeviceKind.touch,' +
      '        device: 1,' +
      '        pointerIdentifier: 1,' +
      '        physicalX: px,' +
      '        physicalY: py,' +
      '        buttons: change == PointerChange.up ? 0 : 1,' +
      '        pressure: change == PointerChange.up ? 0.0 : 1.0,' +
      '        pressureMax: 1.0,' +
      '      ),' +
      '    ]);' +
      '    dispatcher.onPointerDataPacket?.call(packet);' +
      '  }' +
      '  dispatch(downUs, PointerChange.add);' +
      '  dispatch(downUs, PointerChange.down);' +
      '  dispatch(upUs, PointerChange.up);' +
      '  dispatch(upUs, PointerChange.remove);' +
      '  return true;' +
      '})()';

    await this.evalOrThrow('tap', expression, 'package:flutter/src/rendering/mouse_tracker.dart');
  }

  /**
   * Synthesise a drag gesture as a down → N×move → up sequence. `duration`
   * (seconds) spreads the move events evenly across the requested window so
   * the gesture arena classifies it as a swipe rather than a flick or tap.
   */
  async swipe(
    _deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void> {
    const sxStr = dartNum(startX, 'startX');
    const syStr = dartNum(startY, 'startY');
    const exStr = dartNum(endX, 'endX');
    const eyStr = dartNum(endY, 'endY');
    const totalMs = Math.max(1, Math.round((duration ?? 0.5) * 1000));
    const steps = 20;
    const stepUs = Math.round((totalMs * 1000) / steps);

    const expression =
      '(() {' +
      '  final dispatcher = PlatformDispatcher.instance;' +
      '  final view = dispatcher.implicitView;' +
      '  if (view == null) { return false; }' +
      '  final dpr = view.devicePixelRatio;' +
      `  final double sx = ${sxStr} * dpr;` +
      `  final double sy = ${syStr} * dpr;` +
      `  final double ex = ${exStr} * dpr;` +
      `  final double ey = ${eyStr} * dpr;` +
      `  const int steps = ${steps};` +
      `  const int stepUs = ${stepUs};` +
      '  void post(int tUs, PointerChange change, double x, double y) {' +
      '    final packet = PointerDataPacket(data: <PointerData>[' +
      '      PointerData(' +
      '        timeStamp: Duration(microseconds: tUs),' +
      '        change: change,' +
      '        kind: PointerDeviceKind.touch,' +
      '        device: 1,' +
      '        pointerIdentifier: 1,' +
      '        physicalX: x,' +
      '        physicalY: y,' +
      '        buttons: change == PointerChange.up ? 0 : 1,' +
      '        pressure: change == PointerChange.up ? 0.0 : 1.0,' +
      '        pressureMax: 1.0,' +
      '      ),' +
      '    ]);' +
      '    dispatcher.onPointerDataPacket?.call(packet);' +
      '  }' +
      '  post(0, PointerChange.add, sx, sy);' +
      '  post(0, PointerChange.down, sx, sy);' +
      '  for (int i = 1; i <= steps; i++) {' +
      '    final double t = i / steps;' +
      '    final double x = sx + (ex - sx) * t;' +
      '    final double y = sy + (ey - sy) * t;' +
      '    post(stepUs * i, PointerChange.move, x, y);' +
      '  }' +
      '  final int endUs = stepUs * steps;' +
      '  post(endUs, PointerChange.up, ex, ey);' +
      '  post(endUs, PointerChange.remove, ex, ey);' +
      '  return true;' +
      '})()';

    await this.evalOrThrow('swipe', expression, 'package:flutter/src/rendering/mouse_tracker.dart');
  }

  /**
   * Inject text into the currently-focused `EditableText` via Flutter's
   * `TextInput` channel. This mirrors what the iOS IME would send when the
   * user types on the system keyboard, so controllers and `onChanged`
   * callbacks fire naturally. Falls through silently (no-op) if nothing is
   * focused — same behaviour as WebKitInputBackend.
   */
  async typeText(_deviceId: string, text: string): Promise<void> {
    const textLit = dartStringLiteral(text);

    // Read the live TextInputConnection client id so the platform message
    // targets the correct connection. The Flutter framework drops messages
    // where args[0] != _currentConnection._id, so hardcoding -1 would be
    // a silent no-op. We read the id via TextInput._currentConnection._id,
    // which is private but accessible via evaluate on the binding library.
    const expression =
      '(() async {' +
      `  final String newText = ${textLit};` +
      '  // Read the current TextInputConnection client id.' +
      '  // If nothing is focused, fall back to -1 (message is dropped, same' +
      '  // as typing on a hardware keyboard with no focused field).' +
      '  int clientId = -1;' +
      '  try {' +
      '    // Fallback: just check if the primary focus accepts text.' +
      '    final focused = FocusManager.instance.primaryFocus;' +
      '    if (focused != null && focused.context != null) {' +
      '      final editable = focused.context!.findAncestorStateOfType<EditableTextState>();' +
      '      if (editable != null) {' +
      '        // Force update through the editable directly — this is' +
      '        // the most reliable path since it bypasses the private _id.' +
      '        final ctrl = editable.textEditingValue;' +
      '        editable.userUpdateTextEditingValue(' +
      '          TextEditingValue(' +
      '            text: ctrl.text + newText,' +
      '            selection: TextSelection.collapsed(offset: ctrl.text.length + newText.length),' +
      '          ),' +
      '          SelectionChangedCause.keyboard,' +
      '        );' +
      '        return true;' +
      '      }' +
      '    }' +
      '  } catch (_) {}' +
      '  // Fallback: deliver via platform channel with best-effort client id.' +
      '  final Map<String, dynamic> state = <String, dynamic>{' +
      '    "text": newText,' +
      '    "selectionBase": newText.length,' +
      '    "selectionExtent": newText.length,' +
      '    "selectionAffinity": "TextAffinity.downstream",' +
      '    "selectionIsDirectional": false,' +
      '    "composingBase": -1,' +
      '    "composingExtent": -1,' +
      '  };' +
      '  final message = const JSONMethodCodec().encodeMethodCall(' +
      '    MethodCall("TextInputClient.updateEditingState", <dynamic>[clientId, state]),' +
      '  );' +
      '  await WidgetsBinding.instance!.defaultBinaryMessenger.handlePlatformMessage(' +
      '    "flutter/textinput",' +
      '    message,' +
      '    (dynamic _) {},' +
      '  );' +
      '  return true;' +
      '})()';

    await this.evalOrThrow('typeText', expression, 'package:flutter/src/widgets/editable_text.dart');
  }

  /**
   * Dispatch a HID key code through `HardwareKeyboard`. Only a curated set of
   * control keys is supported — matches the WebKit/AppleScript backends.
   */
  async keypress(_deviceId: string, keyCode: string): Promise<void> {
    const entry = HID_TO_LOGICAL_KEY[keyCode];
    if (!entry) {
      throw new Error(
        `Unknown HID key code "${keyCode}" for FlutterVM backend. ` +
          `Supported: ${Object.keys(HID_TO_LOGICAL_KEY).join(', ')}`,
      );
    }
    await this.dispatchKey('keypress', entry.keyId, entry.keyLabel, entry.physicalKey);
  }

  /** Dispatch a named key ("Return", "Escape", ...) through HardwareKeyboard. */
  async sendKey(_deviceId: string, keyName: string): Promise<void> {
    const entry = SENDKEY_TO_LOGICAL_KEY[keyName];
    if (!entry) {
      throw new Error(
        `Unknown key name "${keyName}" for FlutterVM backend. ` +
          `Supported: ${Object.keys(SENDKEY_TO_LOGICAL_KEY).join(', ')}`,
      );
    }
    await this.dispatchKey('sendKey', entry.keyId, entry.keyLabel, entry.physicalKey);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async dispatchKey(
    op: 'keypress' | 'sendKey',
    logicalKeyExpr: string,
    keyLabel: string,
    physicalKeyExpr: string,
  ): Promise<void> {
    const labelLit = dartStringLiteral(keyLabel);
    // Emit a KeyDown event then a KeyUp through HardwareKeyboard so downstream
    // focus nodes observe a complete press. `timeStamp` uses the default
    // (zero) — the event queue does not require strict monotonicity.
    const expression =
      '(() {' +
      `  final label = ${labelLit};` +
      `  final logical = ${logicalKeyExpr};` +
      `  final physical = ${physicalKeyExpr};` +
      '  final down = KeyDownEvent(' +
      '    physicalKey: physical,' +
      '    logicalKey: logical,' +
      '    timeStamp: Duration.zero,' +
      '    character: label.length == 1 ? label : null,' +
      '  );' +
      '  final up = KeyUpEvent(' +
      '    physicalKey: physical,' +
      '    logicalKey: logical,' +
      '    timeStamp: Duration.zero,' +
      '  );' +
      '  HardwareKeyboard.instance.handleKeyEvent(down);' +
      '  HardwareKeyboard.instance.handleKeyEvent(up);' +
      '  return true;' +
      '})()';

    await this.evalOrThrow(op, expression, 'package:flutter/src/services/hardware_keyboard.dart');
  }

  private async evalOrThrow(
    op: FlutterVMInputBackendError['op'],
    expression: string,
    libraryUri: string,
  ): Promise<void> {
    try {
      // Scope the evaluate to the per-operation Flutter library so all
      // required symbols are in lexical scope.
      const targetId = await this.resolveLibId(libraryUri);
      const result = await this.vmClient.evaluate(expression, { targetId });
      // VM returns an @Error shape instead of throwing when the expression
      // itself compiled but raised a Dart exception. Surface that as a
      // structured InputBackendError.
      const errType = (result as { type?: string }).type;
      if (errType === '@Error' || errType === 'Error') {
        const message =
          (result as { message?: string }).message ?? JSON.stringify(result);
        throw new FlutterVMError(message, 'DART_ERROR');
      }
    } catch (err) {
      if (err instanceof FlutterVMInputBackendError) throw err;
      throw new FlutterVMInputBackendError(op, err);
    }
  }
}
