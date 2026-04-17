# Flutter Inspector: Widget Introspection

## Overview

The Flutter Inspector tools provide real-time widget tree inspection for running Flutter apps on iOS Simulator. Two primary tools expose Flutter's inspector service extensions:

- **`flutter_root_widget`** — Returns the complete widget summary tree (`ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews`), including type, description, and source location for every widget.
- **`flutter_inspect_selection`** — Returns the currently selected widget (`ext.flutter.inspector.getSelectedSummaryWidget`), plus an optional overlay toggle to enable coordinate-based selection.

Both tools require an active Flutter VM Service connection via `flutter_connect` (debug or profile builds only).

## Build-mode × Xcode tier matrix (#596)

Flutter build mode determines which input tier the router lands on. **Release builds on Xcode 26+ land on the slowest and most fragile path** — AX-press for element-targeted tools only, AppleScript for coordinate tools — because Tier 0 (`FlutterVMInputBackend`) requires `evaluate` support (Dart AOT cannot compile expressions at runtime) and Tier 1 SimHID tap/swipe is disabled on Xcode 26+ pending the `IndigoHIDMessageForMouseNSEvent` regression fix (#491, #537).

Consumers often pick release mode for "QA" simulator builds to match production performance — and silently forfeit headless coverage. The Flutter toolchain blocks `--profile` for simulator targets (`flutter build ios --simulator --profile` exits with *"Profile mode is not supported for simulators."*), so the only Tier-0-keeping mode on the simulator is `--debug`. Profile mode still applies to physical-device QA. See the [QA-ready Flutter build recipe](./ci-recipes.md#qa-ready-flutter-build) for both flows.

**iOS Simulator (Xcode Simulator runtimes):**

| Build mode | Xcode ≤ 25 | Xcode 26+ | VM Service | Tier 0 (`FlutterVMInputBackend`) |
| --- | --- | --- | --- | --- |
| `debug` | **Tier 0** (all gestures via VM Service) | **Tier 0** (all gestures via VM Service) | ✅ | ✅ `evaluate` available |
| `profile` | n/a — *"Profile mode is not supported for simulators."* | n/a — same toolchain block | n/a | n/a — use `--debug` instead |
| `release` | Tier 1/2/3 (SimHID → simctl → WebKit) | ⚠️ **AX-press for element, AppleScript for coords** | ❌ (AOT) | ❌ falls through (`VM_NO_EVALUATE`) |

**Physical iOS devices:**

| Build mode | VM Service | Tier 0 (`FlutterVMInputBackend`) | Notes |
| --- | --- | --- | --- |
| `debug` | ✅ | ✅ `evaluate` available | Slowest runtime; use only when you need full inspector tooling. |
| `profile` | ✅ | ✅ `evaluate` available | **Recommended for perf-parity device QA** — keeps Tier 0 while running close to release perf. |
| `release` | ❌ (AOT) | ❌ falls through (`VM_NO_EVALUATE`) | Same fall-through behaviour as a release-mode simulator build. |

Legend:

- **Tier 0** `FlutterVMInputBackend` — synthetic `PointerDataPacket` via VM Service, zero OS input, fully headless.
- **Tier 1** `SimulatorKitHIDInputBackend` — IOKit HID events; tap/swipe disabled on Xcode 26+.
- **Tier 1.5** `AccessibilityPressInputBackend` — `AXUIElementPerformAction` for `app_tap_element` / `app_type_element` only.
- **Tier 2/3** `SimctlIOInputBackend` / `NativeInputBackend` (WebKit) — coordinate-only on native UIKit.
- **Tier 4** `AppleScriptInputBackend` — requires `Simulator.app` focus; blocked when `OPENSAFARI_HEADLESS_ONLY=1`.

### Detecting release-mode fall-through

When Tier 0 probes a release build it rejects with `FlutterVMInputBackendError { code: 'VM_NO_EVALUATE' }` whose `.message` surfaces the canonical recipe link. Tool consumers can key on the structured code to prompt users to rebuild with `--profile`, or parse `flutter_connect`'s response metadata (Dart VM flags expose the build mode).

## Flutter Compatibility Matrix

| Flutter version | `flutter_root_widget` | `flutter_inspect_selection` | Inspector method chosen | Notes |
| --- | --- | --- | --- | --- |
| 3.11+ | ✅ | ✅ | `getRootWidgetSummaryTreeWithPreviews` (falls back on error) | Verified against Flutter 3.11.3 on iOS simulator |
| 3.0 – 3.10 | ✅ | ✅ | `getRootWidgetSummaryTreeWithPreviews` first, falls back to `getRootWidgetSummaryTree` on VM Service error -32000 | |
| 2.x | ✅ | ⚠️ | `getRootWidgetSummaryTree` directly (skips `WithPreviews`) | 2.x inspector surface does not expose the `WithPreviews` variant reliably — `flutter_inspect_selection` remains best-effort |
| Unknown | ✅ | ✅ | `getRootWidgetSummaryTreeWithPreviews` first, falls back on any error | Used when `vm.version` cannot be parsed — preserves historical behaviour |

### How the client picks the inspector method

`FlutterVMClient` captures the Dart VM `version` string at `flutter_connect`
time and parses it into `{major, minor, patch}` (see
`parseDartVersion` in `src/flutter/vm-service-client.ts`). Because the Dart
SDK major correlates 1:1 with the Flutter release line (Dart 3.x ships with
Flutter 3.x, Dart 2.x ships with Flutter 2.x), the client branches on
`dartVersion.major`:

- **Dart major ≥ 3** → try `ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews` first, fall back to `getRootWidgetSummaryTree` on any error. This preserves the richer preview metadata on modern Flutter while tolerating the occasional 3.0/3.1 build that omits the extension.
- **Dart major < 3** → call `ext.flutter.inspector.getRootWidgetSummaryTree` directly. Skipping `WithPreviews` avoids a guaranteed round-trip to a -32601 / -32000 error on Flutter 2.x.
- **Version unknown** (unparsable `vm.version`) → use the historical try/catch fallback so no callers regress.

Captured version data is also surfaced in the `flutter_connect` response as
`dartVersion` and `flutterMajor` so downstream tools can gate behaviour on
the running Flutter major.

## Usage

### `flutter_root_widget` — Get the Widget Tree

Fetch the complete widget summary tree of the running Flutter app.

**Request (JSON):**
```json
{
  "device_id": "12345678-1234-1234-1234-123456789012",
  "max_depth": 8,
  "object_group": "opensafari-root"
}
```

**Response:**
```json
{
  "status": "ok",
  "deviceId": "12345678-1234-1234-1234-123456789012",
  "tree": {
    "type": "WidgetsApp",
    "description": "WidgetsApp(…)",
    "creationLocation": {
      "file": "package:myapp/main.dart",
      "line": 15,
      "column": 3
    },
    "children": [
      {
        "type": "MaterialApp",
        "description": "MaterialApp(…)",
        "creationLocation": {
          "file": "package:myapp/main.dart",
          "line": 20,
          "column": 5
        },
        "children": [
          {
            "type": "Scaffold",
            "description": "Scaffold(…)",
            "creationLocation": {
              "file": "package:myapp/pages/home.dart",
              "line": 42,
              "column": 10
            }
          }
        ]
      }
    ]
  }
}
```

**Parameters:**
- `device_id` (string, optional): Simulator UDID. If omitted, uses the active device.
- `max_depth` (number, optional): Maximum tree depth (default: 8, clamped to 64).
- `object_group` (string, optional): Inspector lifetime scope name (default: `"opensafari-root"`).

### `flutter_inspect_selection` — Get the Selected Widget

Read the currently selected widget, with optional overlay toggle for coordinate-based selection.

**Request (JSON) — Enable overlay and prepare for tap:**
```json
{
  "show": true,
  "object_group": "opensafari-selection",
  "device_id": "12345678-1234-1234-1234-123456789012"
}
```

**Response (empty — no widget selected yet):**
```json
{
  "status": "empty",
  "deviceId": "12345678-1234-1234-1234-123456789012",
  "selection": null,
  "hint": "No widget currently selected. Call with show=true, tap a widget in the simulator, then call again with show=false."
}
```

**Request (JSON) — Read selection after tapping:**
```json
{
  "show": false,
  "previous_selection_id": "inspector-ref-12",
  "device_id": "12345678-1234-1234-1234-123456789012"
}
```

**Response (after tapping a widget):**
```json
{
  "status": "ok",
  "deviceId": "12345678-1234-1234-1234-123456789012",
  "selection": {
    "type": "GestureDetector",
    "description": "GestureDetector(…)",
    "valueId": "inspector-ref-42",
    "creationLocation": {
      "file": "package:myapp/widgets/button.dart",
      "line": 10,
      "column": 5
    },
    "widgetRuntimeType": "GestureDetector",
    "stateful": false
  }
}
```

**Parameters:**
- `show` (boolean, optional): Toggle the in-app inspector overlay. Use `true` to arm selection, `false` to disarm.
- `object_group` (string, optional): Inspector lifetime scope name (default: `"opensafari-selection"`).
- `previous_selection_id` (string, optional): Previously selected widget's `valueId` to allow VM object reuse.
- `device_id` (string, optional): Simulator UDID.

## Selection Workflow: Coordinate to Widget

To map a tap coordinate to a widget, use the following pattern:

1. **Enable the overlay** — Call `flutter_inspect_selection({ show: true })` to activate the in-app widget inspector.
2. **Tap the widget** — Use `app_tap({ x: 100, y: 200 })` or another tap tool to touch the app at desired coordinates. The overlay intercepts the tap and records the selected widget.
3. **Read the selection** — Call `flutter_inspect_selection({ show: false })` to disarm the overlay and read which widget was tapped.
4. **Jump to source** — Use the `creationLocation` from the response to navigate to the widget's source file and line.

This pattern is the manual counterpart to `flutter_widget_at_point` (see below), which automates the whole round-trip via a Dart-side hit-test.

## `flutter_widget_at_point` — Coordinate to Widget (Automated)

Map a physical-pixel coordinate (the same coordinate space as simulator screenshots) directly to the topmost Flutter widget, with source location and a filtered ancestor chain of user-defined widgets. No overlay, no tap, no hot-reload required.

### API

**Request:**
```json
{
  "x": 200,
  "y": 400,
  "object_group": "opensafari-hit",
  "device_id": "12345678-1234-1234-1234-123456789012"
}
```

**Response (successful hit):**
```json
{
  "status": "ok",
  "deviceId": "12345678-1234-1234-1234-123456789012",
  "widget_type": "ElevatedButton",
  "description": "ElevatedButton(onPressed: ...)",
  "widget_id": "inspector-ref-42",
  "creation_location": {
    "file": "package:myapp/home.dart",
    "line": 47,
    "column": 12
  },
  "ancestor_chain": [
    {
      "widget_type": "HomePage",
      "creation_location": { "file": "package:myapp/home.dart", "line": 10, "column": 1 }
    },
    {
      "widget_type": "MyCard",
      "creation_location": { "file": "package:myapp/widgets/card.dart", "line": 4, "column": 1 }
    }
  ],
  "view": {
    "width_physical": 1170,
    "height_physical": 2532,
    "device_pixel_ratio": 3
  }
}
```

**Parameters:**
- `x`, `y` (number, **required**): **Physical** pixel coordinates, matching the pixel grid of `app_screenshot_native` output.
- `object_group` (string, optional): Inspector lifetime scope name (default: `"opensafari-hit"`).
- `device_id` (string, optional): Simulator UDID.

### Device Pixel Ratio (DPR) Notes

Physical pixels differ from Flutter's logical pixels by the device's `devicePixelRatio`. The tool reads this live from `WidgetsBinding.instance.platformDispatcher.views.first.devicePixelRatio` so the conversion stays in sync with the running app.

| Device class | Typical DPR | Example conversion |
| --- | --- | --- |
| iPhone (most) | 3.0 | physical (300, 600) → logical (100, 200) |
| iPhone SE / older | 2.0 | physical (200, 400) → logical (100, 200) |
| iPad | 2.0 | physical (400, 800) → logical (200, 400) |

Always pass the **physical** coordinate from your screenshot; the tool handles the divide.

### Out-of-Bounds Behaviour

If `x < 0`, `y < 0`, `x >= width_physical`, or `y >= height_physical`, the tool short-circuits without a hit-test and returns:

```json
{
  "status": "ok",
  "widget_type": null,
  "reason": "out-of-bounds",
  "view": { "width_physical": 1170, "height_physical": 2532, "device_pixel_ratio": 3 }
}
```

This is **not** an error — it lets callers probe coordinates without raising exceptions.

If the coordinate is in-bounds but no widget is hit (e.g. a transparent region with no hit-test participants):

```json
{
  "status": "ok",
  "widget_type": null,
  "reason": "no-hit"
}
```

### `ancestor_chain` Filtering

The chain is obtained from `ext.flutter.inspector.getParentChain` and then filtered to user-defined widgets only. A widget is considered user-defined when its `creationLocation.file` is **not** inside one of the Flutter SDK path markers:

- `package:flutter/`
- `package:flutter_localizations/`
- `package:flutter_test/`
- `package:flutter_web_plugins/`
- `…/flutter/packages/flutter/…`
- `…/flutter/packages/flutter_…`
- `…/hosted/pub.dartlang.org/flutter…`
- `…/hosted/pub.dev/flutter…`

Widgets without a `creationLocation` (framework internals stripped at build time) are also dropped. This keeps the chain focused on source you actually own.

### Implementation Notes

Flutter 3.11 does **not** expose `ext.flutter.inspector.screenToSummaryTree` (verified against the live service-extension list on iPhone 16 simulator). The tool instead drives the hit-test via `flutter_evaluate`:

1. Read `devicePixelRatio` + `physicalSize` from the first `FlutterView`.
2. Convert physical (x, y) → logical using DPR.
3. Run `renderView.hitTest(HitTestResult(), position: Offset(logicalX, logicalY))`.
4. Walk `HitTestResult.path` for the topmost `RenderObject` whose `debugCreator` is a `DebugCreator` and extract its `Element`.
5. Call `WidgetInspectorService.instance.setSelection(element, objectGroup)`.
6. Read back `getSelectedSummaryWidget`.

If `getParentChain` fails (older Flutter / custom build), the tool still returns the primary widget with an empty `ancestor_chain`.

## Selection Persistence Across Hot Reload

### What persists?

- **Inspector overlay state** — `ext.flutter.inspector.show=true` **persists** across a `flutter_hot_reload`. The overlay remains visible after the reload completes.

### What does NOT persist?

- **Selected widget reference** — The selected widget's `valueId` **does not persist**. When Flutter hot reloads, it rebuilds the Element tree and assigns new inspector references. The previous `valueId` becomes stale.

### Recommended workaround

After calling `flutter_hot_reload`:

1. Call `flutter_inspect_selection({ show: true })` again to re-enable the overlay.
2. Perform your tap or selection again.
3. Call `flutter_inspect_selection({ show: false })` to read the new selection.

**Note:** DevTools handles this transparently by re-selecting widgets via source location match (`creationLocation`). OpenSafari currently does not; support for automatic re-selection is a future enhancement.

## Error Conditions

### `Not connected to Flutter VM Service`

You must establish a connection before calling inspector tools.

**Solution:** Call `flutter_connect({ device_id: "...", bundle_id: "..." })` first.

### `status: "empty"` from `flutter_inspect_selection`

No widget is currently selected.

**Solution:**
1. Call `flutter_inspect_selection({ show: true })` to enable the overlay.
2. Tap a widget in the simulator app.
3. Call `flutter_inspect_selection({ show: false })` to read the selection.

### VM Service error -32000 (method not found) on older Flutter

Some Flutter 2.x versions or custom builds may not expose the full inspector extension surface.

**Solution:** `flutter_root_widget` automatically falls back to the older `getRootWidgetSummaryTree` variant. If you encounter persistent errors, file an issue with your Flutter version and device logs.

## See Also

- [Issue #436 — Flutter widget introspection](https://github.com/opensafari/opensafari/issues/436)
- [CHANGELOG.md v0.4.0](../CHANGELOG.md#040---2026-04-14) — Flutter Advanced Debugging & Profiling release notes
- [src/tools/flutter-inspector.ts](../src/tools/flutter-inspector.ts) — Tool implementation
- [src/flutter/vm-service-client.ts](../src/flutter/vm-service-client.ts) — VM Service method signatures
