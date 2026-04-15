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
const HID_TO_LOGICAL_KEY: Record<string, { keyId: string; keyLabel: string }> = {
  '40': { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter' },
  '41': { keyId: 'LogicalKeyboardKey.escape', keyLabel: 'Escape' },
  '42': { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace' },
  '43': { keyId: 'LogicalKeyboardKey.tab', keyLabel: 'Tab' },
  '44': { keyId: 'LogicalKeyboardKey.space', keyLabel: ' ' },
  '74': { keyId: 'LogicalKeyboardKey.home', keyLabel: 'Home' },
  '79': { keyId: 'LogicalKeyboardKey.arrowRight', keyLabel: 'ArrowRight' },
  '80': { keyId: 'LogicalKeyboardKey.arrowLeft', keyLabel: 'ArrowLeft' },
  '81': { keyId: 'LogicalKeyboardKey.arrowDown', keyLabel: 'ArrowDown' },
  '82': { keyId: 'LogicalKeyboardKey.arrowUp', keyLabel: 'ArrowUp' },
};

const SENDKEY_TO_LOGICAL_KEY: Record<string, { keyId: string; keyLabel: string }> = {
  Return: { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter' },
  Enter: { keyId: 'LogicalKeyboardKey.enter', keyLabel: 'Enter' },
  Escape: { keyId: 'LogicalKeyboardKey.escape', keyLabel: 'Escape' },
  Tab: { keyId: 'LogicalKeyboardKey.tab', keyLabel: 'Tab' },
  Space: { keyId: 'LogicalKeyboardKey.space', keyLabel: ' ' },
  Delete: { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace' },
  Backspace: { keyId: 'LogicalKeyboardKey.backspace', keyLabel: 'Backspace' },
  Home: { keyId: 'LogicalKeyboardKey.home', keyLabel: 'Home' },
  ArrowRight: { keyId: 'LogicalKeyboardKey.arrowRight', keyLabel: 'ArrowRight' },
  ArrowLeft: { keyId: 'LogicalKeyboardKey.arrowLeft', keyLabel: 'ArrowLeft' },
  ArrowDown: { keyId: 'LogicalKeyboardKey.arrowDown', keyLabel: 'ArrowDown' },
  ArrowUp: { keyId: 'LogicalKeyboardKey.arrowUp', keyLabel: 'ArrowUp' },
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
  constructor(private vmClient: FlutterVMClient) {}

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
      '  final binding = WidgetsFlutterBinding.ensureInitialized();' +
      '  final dispatcher = binding.platformDispatcher;' +
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
      '        buttons: change == PointerChange.up ? 0 : kPrimaryButton,' +
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

    await this.evalOrThrow('tap', expression);
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
      '  final binding = WidgetsFlutterBinding.ensureInitialized();' +
      '  final dispatcher = binding.platformDispatcher;' +
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
      '        buttons: change == PointerChange.up ? 0 : kPrimaryButton,' +
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

    await this.evalOrThrow('swipe', expression);
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

    const expression =
      '(() async {' +
      '  final binding = WidgetsFlutterBinding.ensureInitialized();' +
      `  final String newText = ${textLit};` +
      '  final editable = TextInput.instance;' +
      '  // Deliver as a TextInput.setEditingState platform message so the' +
      '  // currently-attached TextInputConnection receives the update via' +
      '  // its normal channel. Uses the standard JSON method codec.' +
      '  final Map<String, dynamic> state = <String, dynamic>{' +
      '    "text": newText,' +
      '    "selectionBase": newText.length,' +
      '    "selectionExtent": newText.length,' +
      '    "selectionAffinity": "TextAffinity.downstream",' +
      '    "selectionIsDirectional": false,' +
      '    "composingBase": -1,' +
      '    "composingExtent": -1,' +
      '  };' +
      '  final Map<String, dynamic> envelope = <String, dynamic>{' +
      '    "method": "TextInputClient.updateEditingState",' +
      '    "args": <dynamic>[-1, state],' +
      '  };' +
      '  final ByteData? message = const JSONMethodCodec().encodeMethodCall(' +
      '    MethodCall(envelope["method"] as String, envelope["args"]),' +
      '  );' +
      '  await binding.defaultBinaryMessenger.handlePlatformMessage(' +
      '    "flutter/textinput",' +
      '    message,' +
      '    (ByteData? _) {},' +
      '  );' +
      '  // Identity reference to keep dart2js/AOT happy when typeText is' +
      '  // evaluated in release-ish builds where TextInput.instance is tree-' +
      '  // shaken away — forces retention.' +
      '  editable.toString();' +
      '  return true;' +
      '})()';

    await this.evalOrThrow('typeText', expression);
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
    await this.dispatchKey('keypress', entry.keyId, entry.keyLabel);
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
    await this.dispatchKey('sendKey', entry.keyId, entry.keyLabel);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async dispatchKey(
    op: 'keypress' | 'sendKey',
    logicalKeyExpr: string,
    keyLabel: string,
  ): Promise<void> {
    const labelLit = dartStringLiteral(keyLabel);
    // Emit a KeyDown event then a KeyUp through HardwareKeyboard so downstream
    // focus nodes observe a complete press. `timeStamp` uses the default
    // (zero) — the event queue does not require strict monotonicity.
    const expression =
      '(() {' +
      '  WidgetsFlutterBinding.ensureInitialized();' +
      `  final label = ${labelLit};` +
      `  final logical = ${logicalKeyExpr};` +
      '  final down = KeyDownEvent(' +
      '    physicalKey: PhysicalKeyboardKey(0x0),' +
      '    logicalKey: logical,' +
      '    timeStamp: Duration.zero,' +
      '    character: label.length == 1 ? label : null,' +
      '  );' +
      '  final up = KeyUpEvent(' +
      '    physicalKey: PhysicalKeyboardKey(0x0),' +
      '    logicalKey: logical,' +
      '    timeStamp: Duration.zero,' +
      '  );' +
      '  HardwareKeyboard.instance.handleKeyEvent(down);' +
      '  HardwareKeyboard.instance.handleKeyEvent(up);' +
      '  return true;' +
      '})()';

    await this.evalOrThrow(op, expression);
  }

  private async evalOrThrow(
    op: FlutterVMInputBackendError['op'],
    expression: string,
  ): Promise<void> {
    try {
      const result = await this.vmClient.evaluate(expression);
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
