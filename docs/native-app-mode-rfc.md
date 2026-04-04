# RFC: Native App Automation Backend for Xcode Simulator

**Status**: Draft
**Author**: OpenSafari Contributors
**Issue**: [#351](https://github.com/shaun0927/opensafari/issues/351)
**Parent**: [#344](https://github.com/shaun0927/opensafari/issues/344)
**Date**: 2026-04-05

---

## 1. Problem Statement

OpenSafari currently automates **only Safari** via the WebKit Remote Debugging Protocol. Users increasingly need to test native iOS apps (non-Safari) within the same Xcode Simulator workflow: launching apps, granting permissions, sending push notifications, capturing screenshots, and eventually interacting with UI elements.

Today, there is no abstraction in OpenSafari for native app lifecycle or interaction. Users must shell out to `xcrun simctl` manually, losing the unified MCP tool surface and session management that OpenSafari provides for Safari.

## 2. Goals

1. Provide an MCP tool surface for native iOS app automation alongside existing Safari tools.
2. Introduce a pluggable backend interface (`NativeAppBackend`) so implementations can evolve without breaking consumers.
3. Ship a v1 backend using only `simctl` (zero new dependencies).
4. Preserve full backward compatibility with all existing Safari/WebKit tools.

## 3. Non-Goals (for v1)

- Full accessibility tree traversal (requires XCTest bridge).
- Semantic element targeting (tap by label, swipe on element).
- Hybrid WebView context switching.
- Android or non-Apple platform support.

## 4. Backend Choice

### Option A (selected): Lightweight simctl-based default

| Criterion | simctl | XCTest / WebDriverAgent |
|-----------|--------|------------------------|
| Dependencies | Zero (ships with Xcode) | Needs XCTest runner or WDA build |
| CI friendliness | Excellent (headless capable) | Moderate (needs build step) |
| Lifecycle control | Full (launch/terminate/install/uninstall) | Full |
| Permissions | `simctl privacy` | Runtime prompts |
| Screenshots | `simctl io screenshot` | XCTest snapshots |
| Logs | `simctl spawn log show` | os_log stream |
| Accessibility tree | Not available | Full via XCTest |
| Element interaction | Not available | Full via XCTest |

**Rationale**: `simctl` is zero-dependency, works in headless CI, and covers the most common automation needs (lifecycle, permissions, screenshots, logs, deep links, push notifications). It is the pragmatic default for v1.

**Limitations**: `simctl` provides no direct accessibility tree API and no semantic element targeting. To tap a button by its label or read a screen's element hierarchy, a richer backend is required.

**Future path**: v1.5 introduces an XCTest helper bridge for accessibility tree queries. v2 adds full interaction primitives via XCTest or WebDriverAgent.

## 5. Versioned Scope

### v1 — simctl foundation (this PR series)

- App lifecycle: `app_launch`, `app_terminate`, `app_list`
- Permissions: `app_set_permission`
- Deep links: `app_open_url`
- Push notifications: `app_push_notification`
- Screenshots: `app_screenshot`
- Logs: `app_logs`

### v1.5 — Accessibility tree (future)

- `app_tree` — full accessibility hierarchy via XCTest helper
- `app_query` — semantic element queries (by label, role, identifier)
- `app_alert` — system alert handling

### v2 — Full interaction (future)

- `app_tap` — tap element by selector or coordinates
- `app_type` — type text into focused element or target
- `app_swipe` — directional swipe gestures
- Hybrid context switching: `safari` <-> `native-app` <-> `webview`

## 6. Tool Naming Convention

All native app tools use the `app_` prefix to distinguish them from existing Safari/WebKit tools:

| Tool | Version | Description |
|------|---------|-------------|
| `app_launch` | v1 | Launch an app by bundle ID |
| `app_terminate` | v1 | Terminate a running app |
| `app_list` | v1 | List installed apps on device |
| `app_set_permission` | v1 | Grant/revoke/reset a permission |
| `app_open_url` | v1 | Open a URL (deep link) on device |
| `app_push_notification` | v1 | Send a push notification payload |
| `app_screenshot` | v1 | Capture device screenshot |
| `app_logs` | v1 | Retrieve app logs |
| `app_tree` | v1.5 | Get accessibility tree |
| `app_query` | v1.5 | Query elements by selector |
| `app_alert` | v1.5 | Handle system alerts |
| `app_tap` | v2 | Tap an element or coordinate |
| `app_type` | v2 | Type text |
| `app_swipe` | v2 | Swipe gesture |

## 7. Context Model

OpenSafari will support multiple automation contexts:

| Context | Backend | Status |
|---------|---------|--------|
| `safari` | WebKit Remote Debugging Protocol | Existing (stable) |
| `native-app` | NativeAppBackend (simctl for v1) | New |
| `webview` | Hybrid: native context + WebKit for embedded views | Future (v2) |

Context switching is explicit. Existing Safari tools continue to work exactly as before. Native app tools operate independently. The `webview` context (v2) will bridge both worlds for apps with embedded web views.

## 8. Backward Compatibility

- **No changes** to any existing Safari/WebKit tool.
- **No changes** to the MCP server initialization or transport layer.
- **No new dependencies** for v1 (simctl ships with Xcode).
- Native tools are additive: they register new MCP tools without modifying existing ones.
- The `NativeAppBackend` interface is independent from the WebKit client.

## 9. Dependency Impact

| Version | New Dependencies |
|---------|-----------------|
| v1 | None (simctl only) |
| v1.5 | XCTest helper binary (compiled from Swift, bundled) |
| v2 | Possibly WebDriverAgent or custom XCTest runner |

## 10. Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Server                      │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Safari Tools  │  │  Native App Tools       │  │
│  │ (navigate,    │  │  (app_launch,           │  │
│  │  click, etc.) │  │   app_terminate, etc.)  │  │
│  └──────┬───────┘  └──────────┬──────────────┘  │
│         │                     │                  │
│  ┌──────▼───────┐  ┌─────────▼──────────────┐  │
│  │ WebKitClient  │  │  NativeAppBackend      │  │
│  │ (existing)    │  │  (interface)           │  │
│  └──────┬───────┘  └─────────┬──────────────┘  │
│         │                     │                  │
│         │           ┌─────────▼──────────────┐  │
│         │           │  SimctlNativeBackend   │  │
│         │           │  (v1 implementation)   │  │
│         │           └─────────┬──────────────┘  │
│         │                     │                  │
└─────────┼─────────────────────┼──────────────────┘
          │                     │
  ┌───────▼───────┐   ┌────────▼────────────┐
  │ WebKit Remote  │   │  xcrun simctl       │
  │ Debug Protocol │   │  (Xcode CLI)        │
  └───────┬───────┘   └────────┬────────────┘
          │                     │
  ┌───────▼─────────────────────▼───────┐
  │         Xcode Simulator              │
  │  ┌─────────┐  ┌──────────────────┐  │
  │  │ Safari   │  │  Native Apps     │  │
  │  └─────────┘  └──────────────────┘  │
  └─────────────────────────────────────┘
```

## 11. MCP Tool Surface — Example Inputs/Outputs

### `app_launch`

**Input**:
```json
{
  "bundleId": "com.example.myapp",
  "deviceId": "booted",
  "arguments": ["--reset-state"],
  "environment": { "DEBUG": "1" }
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Launched com.example.myapp (PID: 12345) on iPhone 16 Pro (booted)"
  }]
}
```

### `app_terminate`

**Input**:
```json
{
  "bundleId": "com.example.myapp"
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Terminated com.example.myapp"
  }]
}
```

### `app_list`

**Input**:
```json
{
  "deviceId": "booted"
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Installed apps:\n- com.apple.mobilesafari (Safari)\n- com.example.myapp (MyApp)\n- com.apple.Preferences (Settings)"
  }]
}
```

### `app_set_permission`

**Input**:
```json
{
  "bundleId": "com.example.myapp",
  "permission": "camera",
  "value": "grant"
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Permission 'camera' granted for com.example.myapp"
  }]
}
```

### `app_open_url`

**Input**:
```json
{
  "url": "myapp://profile/settings",
  "deviceId": "booted"
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Opened URL: myapp://profile/settings"
  }]
}
```

### `app_push_notification`

**Input**:
```json
{
  "bundleId": "com.example.myapp",
  "payload": {
    "aps": {
      "alert": { "title": "Test", "body": "Hello from OpenSafari" },
      "sound": "default"
    }
  }
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "Push notification sent to com.example.myapp"
  }]
}
```

### `app_screenshot`

**Input**:
```json
{
  "deviceId": "booted"
}
```

**Output**:
```json
{
  "content": [{
    "type": "image",
    "data": "<base64-encoded-png>",
    "mimeType": "image/png"
  }]
}
```

### `app_logs`

**Input**:
```json
{
  "bundleId": "com.example.myapp",
  "lines": 50,
  "since": "2026-04-05T10:00:00Z"
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "2026-04-05 10:01:23 [INFO] App launched\n2026-04-05 10:01:24 [DEBUG] Loading config..."
  }]
}
```

## 12. Open Questions

1. **Device resolution**: Should native app tools share the same device resolution logic as Safari tools, or maintain their own device context?
2. **Session model**: Should `app_launch` create a "native session" analogous to a Safari session, or remain stateless?
3. **Screenshot format**: Should `app_screenshot` return the same format as the existing `screenshot` tool (base64 PNG)?

## 13. References

- [xcrun simctl documentation](https://developer.apple.com/documentation/xcode/simulating-your-app-in-the-simulator)
- [Issue #344 — Native app automation support](https://github.com/shaun0927/opensafari/issues/344)
- [Issue #351 — RFC: native app automation backend](https://github.com/shaun0927/opensafari/issues/351)
