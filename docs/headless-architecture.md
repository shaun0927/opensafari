# Headless Input Architecture

## Input Backend Tiers

opensafari routes native-app input through a tiered fallback strategy. Each tier is attempted in order; the first available backend wins.

| Tier | Backend | Scope | Headless | Opt-in |
|------|---------|-------|----------|--------|
| 0 | `FlutterVMInputBackend` | Flutter apps (debug/profile via `flutter run`) | Yes | None |
| 1 | `SimctlInputBackend` | Any app (Xcode ≤16) | Yes | None |
| 2 | `WebKitInputBackend` | Safari web content only | Yes | None |
| 3 | `AppleScriptInputBackend` | Any app | No (moves mouse, steals focus) | `OPENSAFARI_ALLOW_FOCUS_INPUT=1` |

## Tier 0 — Flutter VM Input (Issue #481)

Dispatches pointer/keyboard/text events directly into the Dart isolate via VM Service `evaluate`. No CGEvent, no Simulator.app foregrounding.

### Requirements

- Flutter app running in **debug or profile** mode
- Launched via `flutter run` (the DDS/frontend compiler is required for `evaluate`)
- Apps launched via `simctl launch` expose VM Service but NOT the compilation service

### Library Scoping

The Dart `evaluate` RPC compiles expressions in the scope of a target library. Since no single Flutter library imports all required symbols, each operation targets a different library:

| Operation | Target Library | Key Symbols |
|-----------|---------------|-------------|
| tap, swipe | `rendering/mouse_tracker.dart` | `PlatformDispatcher`, `PointerDataPacket`, `PointerChange`, `PointerDeviceKind` (bare `import 'dart:ui'`) |
| typeText | `widgets/editable_text.dart` | `FocusManager`, `EditableTextState`, `TextEditingValue`, `SelectionChangedCause` |
| keypress, sendKey | `services/hardware_keyboard.dart` | `HardwareKeyboard`, `KeyDownEvent`, `KeyUpEvent`, `LogicalKeyboardKey` |

### Coordinate System

iOS AX frames use logical points. The Dart payload multiplies by `devicePixelRatio` from the implicit view to convert to the engine's physical pixel expectations.
