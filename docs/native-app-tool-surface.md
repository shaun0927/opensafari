# Native-App MCP Tool Surface Design

- **Date:** 2026-04-05
- **Status:** Proposed
- **Related:** #344, #345
- **Complements:** RFC #357 (backend abstraction), #358 (implementation plan)

---

## 1. Design Principles

All native-app tools follow the same conventions as the existing 68 Safari tools:

| Principle | Detail |
|-----------|--------|
| **Namespace** | `app_*` prefix for every native-app tool — clear separation from Safari tools |
| **Naming** | `snake_case` flat namespace, no dot or slash separators |
| **Progressive disclosure** | Same Tier 1 / Tier 2 / Tier 3 structure as existing tools |
| **Registration** | `registerTool(definition, handler)` — identical pattern |
| **Return type** | `MCPResult` — identical to all existing tools |
| **Backward compatibility** | All 68 existing Safari tools are unchanged; new tools are purely additive |

Default automation context remains Safari. Native-app tools are available when
`--all-tools` is passed to `opensafari serve` or when individual tiers are
explicitly promoted.

---

## 2. Tool Catalog

### Tier 1: Core Native App Tools (8 tools)

#### app_launch

Launch a native app on the iOS Simulator.

```json
{
  "name": "app_launch",
  "description": "Launch a native app on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": {
        "type": "string",
        "description": "App bundle identifier (e.g., com.apple.Preferences)"
      },
      "args": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Launch arguments"
      },
      "env": {
        "type": "object",
        "description": "Environment variables for the app"
      },
      "deviceId": {
        "type": "string",
        "description": "Target simulator device ID (defaults to active device)"
      }
    },
    "required": ["bundleId"]
  }
}
```

- **Returns:** `{ bundleId, name, state, pid }`
- **Implementation:** `xcrun simctl launch <deviceId> <bundleId> [args...]`

---

#### app_terminate

Terminate a running native app on the iOS Simulator.

```json
{
  "name": "app_terminate",
  "description": "Terminate a running native app on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": {
        "type": "string",
        "description": "App bundle identifier"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId"]
  }
}
```

- **Implementation:** `xcrun simctl terminate <deviceId> <bundleId>`

---

#### app_state

Get the running state of an app (`not-running`, `running`, `suspended`).

```json
{
  "name": "app_state",
  "description": "Get the running state of an app on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": { "type": "string", "description": "App bundle identifier" },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId"]
  }
}
```

- **Returns:** `{ bundleId, state: 'not-running' | 'running' | 'suspended' }`
- **Implementation:** `xcrun simctl get_app_container` + process check

---

#### app_list

List installed apps on the simulator.

```json
{
  "name": "app_list",
  "description": "List installed apps on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "deviceId": { "type": "string" }
    }
  }
}
```

- **Returns:** Array of `{ bundleId, name, state }`

---

#### app_screenshot

Take a screenshot of the full simulator screen (not just Safari).

```json
{
  "name": "app_screenshot",
  "description": "Take a screenshot of the full iOS Simulator screen",
  "inputSchema": {
    "type": "object",
    "properties": {
      "deviceId": { "type": "string" }
    }
  }
}
```

- **Returns:** Base64 PNG — same format as the existing `screenshot` tool
- **Implementation:** `xcrun simctl io <deviceId> screenshot`

---

#### app_tap

Tap on an element or coordinate in a native app.

```json
{
  "name": "app_tap",
  "description": "Tap on an element or coordinate in a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "number", "description": "X coordinate" },
      "y": { "type": "number", "description": "Y coordinate" },
      "identifier": {
        "type": "string",
        "description": "Accessibility identifier to tap"
      },
      "label": {
        "type": "string",
        "description": "Accessibility label to tap"
      },
      "deviceId": { "type": "string" }
    }
  }
}
```

- Either `(x, y)` coordinates or `identifier` / `label` must be provided.
- **Implementation:** Coordinate-based touch injection via simctl HID events

---

#### app_type

Type text into the currently focused field in a native app.

```json
{
  "name": "app_type",
  "description": "Type text into the currently focused field in a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Text to type" },
      "deviceId": { "type": "string" }
    },
    "required": ["text"]
  }
}
```

- **Implementation:** simctl keyboard input or LLDB text injection

---

#### app_accessibility_tree

Get the accessibility tree of the current app screen.

```json
{
  "name": "app_accessibility_tree",
  "description": "Get the accessibility tree of the current app screen",
  "inputSchema": {
    "type": "object",
    "properties": {
      "depth": {
        "type": "number",
        "description": "Maximum tree depth (default: unlimited)"
      },
      "deviceId": { "type": "string" }
    }
  }
}
```

- **Returns:** Recursive tree of `{ type, label, value, identifier, frame, traits, children, isEnabled, isSelected }`

---

### Tier 2: Advanced Native App Tools (7 tools)

#### app_find_element

Query the accessibility tree by type, label, identifier, or value.

```json
{
  "name": "app_find_element",
  "description": "Query the accessibility tree for elements matching given criteria",
  "inputSchema": {
    "type": "object",
    "properties": {
      "type": { "type": "string", "description": "Element type (e.g., Button, TextField)" },
      "label": { "type": "string", "description": "Accessibility label" },
      "identifier": { "type": "string", "description": "Accessibility identifier" },
      "value": { "type": "string", "description": "Element value" },
      "deviceId": { "type": "string" }
    }
  }
}
```

- **Returns:** Array of matching elements with full accessibility info

---

#### app_element_info

Get detailed info about a specific accessibility element.

```json
{
  "name": "app_element_info",
  "description": "Get detailed accessibility info for a specific element",
  "inputSchema": {
    "type": "object",
    "properties": {
      "identifier": { "type": "string", "description": "Accessibility identifier" },
      "x": { "type": "number", "description": "Element center X coordinate" },
      "y": { "type": "number", "description": "Element center Y coordinate" },
      "deviceId": { "type": "string" }
    }
  }
}
```

- **Returns:** `{ type, label, value, identifier, frame, traits, isEnabled, isSelected, children }`

---

#### app_swipe

Perform a swipe gesture with configurable direction and speed.

```json
{
  "name": "app_swipe",
  "description": "Perform a swipe gesture in a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "direction": {
        "type": "string",
        "enum": ["up", "down", "left", "right"],
        "description": "Swipe direction"
      },
      "speed": {
        "type": "number",
        "description": "Swipe speed multiplier (default: 1.0)"
      },
      "startX": { "type": "number" },
      "startY": { "type": "number" },
      "deviceId": { "type": "string" }
    },
    "required": ["direction"]
  }
}
```

---

#### app_long_press

Long press on an element or coordinate with configurable duration.

```json
{
  "name": "app_long_press",
  "description": "Long press on an element or coordinate in a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "number" },
      "y": { "type": "number" },
      "identifier": { "type": "string", "description": "Accessibility identifier" },
      "duration": {
        "type": "number",
        "description": "Press duration in milliseconds (default: 1000)"
      },
      "deviceId": { "type": "string" }
    }
  }
}
```

---

#### app_deep_link

Open a deep link URL that routes into the app.

```json
{
  "name": "app_deep_link",
  "description": "Open a deep link URL that routes to a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Deep link URL (e.g., myapp://path/to/screen)" },
      "deviceId": { "type": "string" }
    },
    "required": ["url"]
  }
}
```

- **Implementation:** `xcrun simctl openurl <deviceId> <url>`

---

#### app_alert_handle

Handle system alerts such as permission dialogs.

```json
{
  "name": "app_alert_handle",
  "description": "Handle a system alert or permission dialog",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["accept", "dismiss", "getButtons"],
        "description": "Action to take on the alert"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["action"]
  }
}
```

- **Returns:** `{ action, button?, buttons? }` — when `getButtons`, returns list of button titles

---

#### app_permission

Set a runtime permission for an app.

```json
{
  "name": "app_permission",
  "description": "Set a runtime permission for a native app on the simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": { "type": "string", "description": "App bundle identifier" },
      "permission": {
        "type": "string",
        "description": "Permission name (e.g., location, camera, photos, notifications, microphone)"
      },
      "value": {
        "type": "string",
        "enum": ["yes", "no", "unset"],
        "description": "Permission state to set"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId", "permission", "value"]
  }
}
```

- **Implementation:** `xcrun simctl privacy <deviceId> <grant|revoke|reset> <bundleId> <permission>`

---

### Tier 3: Orchestration Native App Tools (5 tools)

#### app_install

Install an `.app` or `.ipa` on the simulator.

```json
{
  "name": "app_install",
  "description": "Install an .app or .ipa bundle on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to .app directory or .ipa file" },
      "deviceId": { "type": "string" }
    },
    "required": ["path"]
  }
}
```

- **Implementation:** `xcrun simctl install <deviceId> <path>`

---

#### app_uninstall

Remove an app from the simulator.

```json
{
  "name": "app_uninstall",
  "description": "Uninstall an app from the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": { "type": "string", "description": "App bundle identifier" },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId"]
  }
}
```

- **Implementation:** `xcrun simctl uninstall <deviceId> <bundleId>`

---

#### app_screen_recording

Start or stop a screen recording of the simulator.

```json
{
  "name": "app_screen_recording",
  "description": "Start or stop a screen recording of the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["start", "stop"],
        "description": "Recording action"
      },
      "path": {
        "type": "string",
        "description": "Output file path (required for start; mp4 extension recommended)"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["action"]
  }
}
```

- **Implementation:** `xcrun simctl io <deviceId> recordVideo <path>`

---

#### app_logs

Stream or capture app console logs.

```json
{
  "name": "app_logs",
  "description": "Get console logs from a native app on the iOS Simulator",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": { "type": "string", "description": "App bundle identifier" },
      "lines": {
        "type": "number",
        "description": "Number of recent log lines to return (default: 100)"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId"]
  }
}
```

- **Implementation:** `xcrun simctl spawn <deviceId> log stream --predicate 'processImagePath CONTAINS "<appName>"'`

---

#### app_push_notification

Send a push notification payload to an app.

```json
{
  "name": "app_push_notification",
  "description": "Send a simulated push notification to a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": { "type": "string", "description": "App bundle identifier" },
      "payload": {
        "type": "object",
        "description": "APNs payload object",
        "properties": {
          "aps": {
            "type": "object",
            "properties": {
              "alert": { "type": "object" },
              "badge": { "type": "number" },
              "sound": { "type": "string" }
            }
          }
        },
        "required": ["aps"]
      },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId", "payload"]
  }
}
```

- **Implementation:** `xcrun simctl push <deviceId> <bundleId> <payload.json>`

---

### Hybrid Flow Tools (2 tools)

These tools bridge native-app automation with the existing Safari/WebKit tool set.

#### app_webview_connect

Detect and connect to a WebView embedded inside a native app, then expose it
as a target for existing Safari tools.

```json
{
  "name": "app_webview_connect",
  "description": "Detect and connect to a WebView inside a running native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundleId": {
        "type": "string",
        "description": "Bundle identifier of the host app"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["bundleId"]
  }
}
```

- **Returns:** Array of available WebView targets — `{ targetId, title, url }`
- After calling this tool, the matched target is addressable by all existing
  Safari/WebKit tools (navigate, javascript, read_page, etc.) via the standard
  WebKit Remote Debugging Protocol connection.

---

#### set_active_context

Switch the active automation context between Safari and a native app.

```json
{
  "name": "set_active_context",
  "description": "Switch the active automation context between Safari and a native app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "context": {
        "type": "string",
        "enum": ["safari", "native-app"],
        "description": "Target automation context"
      },
      "bundleId": {
        "type": "string",
        "description": "Required when context is 'native-app'"
      },
      "deviceId": { "type": "string" }
    },
    "required": ["context"]
  }
}
```

- After switching, subsequent generic tools (e.g., `screenshot`) route to the
  active context.
- Default context is `safari` (existing behavior preserved).

---

## 3. Tool Tier Assignment Table

| Tool | Tier | Category | Primary simctl Command |
|------|------|----------|------------------------|
| `app_launch` | 1 | Lifecycle | `simctl launch` |
| `app_terminate` | 1 | Lifecycle | `simctl terminate` |
| `app_state` | 1 | Lifecycle | `simctl get_app_container` + process check |
| `app_list` | 1 | Lifecycle | `simctl listapps` |
| `app_screenshot` | 1 | Capture | `simctl io screenshot` |
| `app_tap` | 1 | Interaction | HID touch injection |
| `app_type` | 1 | Interaction | simctl keyboard / LLDB |
| `app_accessibility_tree` | 1 | Introspection | Accessibility snapshot |
| `app_find_element` | 2 | Introspection | Accessibility snapshot + query |
| `app_element_info` | 2 | Introspection | Accessibility snapshot |
| `app_swipe` | 2 | Interaction | HID swipe injection |
| `app_long_press` | 2 | Interaction | HID long-press injection |
| `app_deep_link` | 2 | Navigation | `simctl openurl` |
| `app_alert_handle` | 2 | Interaction | Accessibility action |
| `app_permission` | 2 | Configuration | `simctl privacy` |
| `app_install` | 3 | Orchestration | `simctl install` |
| `app_uninstall` | 3 | Orchestration | `simctl uninstall` |
| `app_screen_recording` | 3 | Capture | `simctl io recordVideo` |
| `app_logs` | 3 | Diagnostics | `simctl spawn log stream` |
| `app_push_notification` | 3 | Orchestration | `simctl push` |
| `app_webview_connect` | — | Hybrid | WebKit Remote Debugging |
| `set_active_context` | — | Hybrid | Context router (no simctl) |

---

## 4. Backward Compatibility Plan

| Area | Change | Impact |
|------|--------|--------|
| Existing 68 Safari tools | **None** | Zero breaking changes |
| Default automation context | Remains `safari` | Existing scripts unaffected |
| `opensafari serve` startup | Unchanged | No new required flags |
| Tool parameters | No existing params changed | Fully backward compatible |
| Return formats | No existing formats changed | Fully backward compatible |
| New tools availability | `--all-tools` or explicit tier flag | Opt-in only |
| Migration path | None required | Purely additive surface |

---

## 5. Error Handling

New error codes introduced for native-app scenarios (extend the existing error
taxonomy):

| Error Code | Applicable Tools | Source |
|------------|-----------------|--------|
| `APP_NOT_INSTALLED` | `app_launch`, `app_state` | Pre-existing (reused) |
| `APP_LAUNCH_FAILED` | `app_launch` | Pre-existing (reused) |
| `APP_NOT_RUNNING` | `app_terminate`, `app_tap`, `app_type` | Pre-existing (reused) |
| `ACCESSIBILITY_UNAVAILABLE` | `app_accessibility_tree`, `app_find_element` | **New** |
| `NATIVE_GESTURE_FAILED` | `app_tap`, `app_swipe`, `app_long_press` | **New** |
| `APP_STATE_UNKNOWN` | `app_state` | **New** |

---

## 6. Implementation Priority

The following order mirrors the RFC #357 milestones and provides the fastest
path to a working end-to-end native-automation loop:

1. **`app_launch` + `app_terminate` + `app_state` + `app_list`** — Lifecycle
   foundation; unblocks all other tools.
2. **`app_screenshot`** — Visual feedback; confirms simulator state at each step.
3. **`app_accessibility_tree`** — Element discovery backbone; required by
   `app_tap` (identifier path) and `app_find_element`.
4. **`app_tap` + `app_type`** — Core interactions; makes automation scripts
   useful immediately.
5. **`app_deep_link`** — High-value navigation shortcut; low implementation cost.
6. **`app_permission` + `app_alert_handle`** — Permission scaffolding; needed
   for camera/location test suites.
7. **`app_find_element` + `app_element_info`** — Query layer on top of
   accessibility tree.
8. **`app_swipe` + `app_long_press`** — Extended gestures.
9. **`app_webview_connect` + `set_active_context`** — Hybrid bridge; requires
   lifecycle + basic interaction tools to be stable first.
10. **`app_install` + `app_uninstall`** — CI integration tier.
11. **`app_logs`** — Diagnostics; useful for debugging test failures.
12. **`app_screen_recording`** — Recording; nice-to-have for CI artifacts.
13. **`app_push_notification`** — Notification testing; depends on app lifecycle
    being solid.
