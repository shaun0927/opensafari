# Flutter Inspector: Widget Introspection

## Overview

The Flutter Inspector tools provide real-time widget tree inspection for running Flutter apps on iOS Simulator. Two primary tools expose Flutter's inspector service extensions:

- **`flutter_root_widget`** — Returns the complete widget summary tree (`ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews`), including type, description, and source location for every widget.
- **`flutter_inspect_selection`** — Returns the currently selected widget (`ext.flutter.inspector.getSelectedSummaryWidget`), plus an optional overlay toggle to enable coordinate-based selection.

Both tools require an active Flutter VM Service connection via `flutter_connect` (debug or profile builds only).

## Flutter Compatibility Matrix

| Flutter version | `flutter_root_widget` | `flutter_inspect_selection` | Notes |
| --- | --- | --- | --- |
| 3.0 – 3.10 | ✅ | ✅ | Uses `getRootWidgetSummaryTree` fallback when `WithPreviews` variant unavailable |
| 3.11+ | ✅ | ✅ | Verified against Flutter 3.11.3 on iOS simulator |
| 2.x | ⚠️ | ⚠️ | Best-effort; inspector extension surface differs — file an issue if you hit errors |

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

This pattern is the foundation for `flutter_widget_at_point`, a follow-up tool tracked in [issue #436](https://github.com/opensafari/opensafari/issues/436).

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

- [Issue #436 — Flutter widget introspection](https://github.com/opensafari/opensafari/issues/436) (coordinate-based selection follow-up)
- [CHANGELOG.md v0.4.0](../CHANGELOG.md#040---2026-04-14) — Flutter Advanced Debugging & Profiling release notes
- [src/tools/flutter-inspector.ts](../src/tools/flutter-inspector.ts) — Tool implementation
- [src/flutter/vm-service-client.ts](../src/flutter/vm-service-client.ts) — VM Service method signatures
