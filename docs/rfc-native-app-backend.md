# RFC: Native-App Automation Backend for Xcode Simulator

| Field | Value |
|-------|-------|
| **Date** | 2026-04-05 |
| **Status** | Historical / Superseded |
| **Author** | OpenSafari Contributors |
| **Parent Issue** | [#344](https://github.com/shaun0927/opensafari/issues/344) — Native-app automation epic |
| **RFC Issue** | [#345](https://github.com/shaun0927/opensafari/issues/345) — RFC/ADR document |

> This document preserves the architecture discussion that preceded the shipped
> native backend. Safari-only statements, tool counts, and future-tense AX or
> WebView claims are historical. Use
> [Product Direction](product-direction.md) for current scope and stability.

---

## 1. Summary

This RFC proposes adding a `NativeBackend` abstraction to OpenSafari that enables automation of arbitrary native iOS apps running in the Xcode Simulator — alongside the existing Safari/WebKit backend — using `xcrun simctl` for app lifecycle management and the iOS Accessibility framework for UI queries and interactions. A new `AutomationBackend` umbrella type unifies both backends under the existing `SessionManager`, while all 68 current MCP tools remain unchanged.

---

## 2. Motivation

OpenSafari today automates Safari exclusively via the WebKit Remote Debugging Protocol. A growing class of mobile QA scenarios requires testing:

- Native iOS apps that do not embed a WebView (e.g. banking apps, system apps)
- Hybrid flows where a user journey starts in Safari, deep-links into a native app, performs an action, and returns to Safari
- Push-notification and permission-dialog handling that only the native layer can observe
- App-to-app workflows (e.g. OAuth flows that switch between apps)

None of these are reachable through WebKit inspection. Adding a `NativeBackend` closes this gap without splitting OpenSafari into a separate project, because the two backends share the same simulator lifecycle, the same `SessionManager` device map, and the same MCP transport.

---

## 3. Current Architecture

OpenSafari connects directly to the WebKit Inspector socket exposed by ios-webkit-debug-proxy and sends/receives WebKit Remote Debugging Protocol messages.

```
┌────────────────────────────────────────┐
│  MCP Client (LLM / IDE)                │
└───────────────┬────────────────────────┘
                │ 68 MCP tools (stdio JSON-RPC)
┌───────────────▼────────────────────────┐
│  SessionManager                        │
│  deviceId → BrowserBackend             │
└───────────────┬────────────────────────┘
                │ BrowserBackend interface
┌───────────────▼────────────────────────┐
│  WebKitClient                          │
│  implements BrowserBackend             │
└───────────────┬────────────────────────┘
                │ WebSocket ws://localhost:922x
┌───────────────▼────────────────────────┐
│  ios-webkit-debug-proxy                │
└───────────────┬────────────────────────┘
                │ WebKit Remote Debugging Protocol
┌───────────────▼────────────────────────┐
│  Safari in Xcode Simulator             │
└────────────────────────────────────────┘
```

Key existing abstractions:

- **`BrowserBackend`** (`src/types/browser-backend.ts`) — lifecycle, navigation, screenshot, evaluate, cookies, DOM, interactions, events
- **`SessionManager`** (`src/session-manager.ts`) — device-agnostic; maps `deviceId → BrowserBackend`
- **`WebKitClient`** (`src/webkit/client.ts`) — concrete `BrowserBackend` implementation
- **`ErrorCode`** (`src/errors/codes.ts`) — already includes `APP_NOT_INSTALLED`, `APP_LAUNCH_FAILED`, `APP_NOT_RUNNING`

---

## 4. Backend Candidates

Three approaches were evaluated. Each is assessed across five axes: how it works, pros, cons, complexity, performance, and maintenance cost.

### Candidate A: XCUITest Bridge

**How it works:** Compile and deploy a thin XCUITest runner app into the simulator. The runner exposes a local HTTP or WebSocket bridge. OpenSafari drives the bridge with requests (tap, type, query accessibility tree). Each test session compiles and re-installs the runner.

| Axis | Rating | Notes |
|------|--------|-------|
| Complexity | Medium-High | Requires maintaining an Xcode project alongside the Node.js codebase |
| Performance | Medium | Cold-start compile latency of 5–10 s per session; fast at runtime |
| Maintenance | Medium | Runner app must track Xcode API changes; Swift/ObjC + Node.js split |

**Pros:**
- Official Apple XCTest framework; full accessibility API coverage
- Rich gesture synthesis (inertial scroll, multi-touch, force press)
- Native system-alert and permission-dialog handling

**Cons:**
- Per-session compile step is incompatible with the fast startup expected from MCP tool calls
- Adds an Xcode project dependency to a pure Node.js project
- Swift build errors surface as opaque failures to the Node.js layer

---

### Candidate B: WebDriverAgent (WDA) Style

**How it works:** A long-running XCUITest app is installed once in the simulator and exposes a REST API on a device-local port (mirroring the Facebook/Appium WebDriverAgent pattern). OpenSafari sends W3C WebDriver-style requests to that REST API.

| Axis | Rating | Notes |
|------|--------|-------|
| Complexity | High | Must fork/vendor WDA or build an equivalent; complex session lifecycle |
| Performance | Good | No per-session compile; persistent server responds in ~50–100 ms |
| Maintenance | High | WDA releases lag Xcode by weeks–months; two-repo dependency |

**Pros:**
- Battle-tested by Appium and Facebook's large-scale mobile CI
- No per-session compile; simulator stays warm across sessions
- Rich REST API documented by W3C WebDriver spec

**Cons:**
- OpenSafari must maintain or pin a WDA fork — a significant ongoing burden
- WDA port conflicts with Appium installations on the same machine
- Session management overhead (WDA sessions vs. OpenSafari sessions must be reconciled)
- Contradicts the project's design goal of zero external servers beyond ios-webkit-debug-proxy

---

### Candidate C: simctl + Accessibility Snapshots (RECOMMENDED)

**How it works:** Use `xcrun simctl` CLI commands for app lifecycle (launch, terminate, list installed apps, open deep links). Use the iOS Accessibility Inspector protocol (exposed via `xcrun accessibility_inspector` or the `AXUIElement` private framework snapshot API) for UI tree queries. Inject coordinate-based touch events via `xcrun simctl io <device> enumerate` and the HID event injection interface.

| Axis | Rating | Notes |
|------|--------|-------|
| Complexity | Low-Medium | All tools are CLI or stable Apple APIs; no Xcode project needed |
| Performance | Good | No compile step; `simctl` commands respond in <200 ms |
| Maintenance | Low | `simctl` is a stable, first-party Apple CLI; breaking changes are rare |

**Pros:**
- Zero compile step — tools are available immediately after simulator boot
- No additional app needs to be installed into the simulator
- `simctl` is already used by OpenSafari for device lifecycle (boot, openurl)
- Lightweight: no long-running process, no port to manage
- Accessibility snapshot provides the full UI tree (labels, traits, frames) sufficient for element targeting

**Cons:**
- Gesture API is coordinate-based rather than semantic (tap element by accessibility ID)
- Custom views that do not implement `UIAccessibility` will be invisible to the snapshot
- `xcrun accessibility_inspector` snapshot API is semi-private; may require fallback paths across iOS/Xcode versions

**Key commands:**

```bash
# App lifecycle
xcrun simctl launch <device> <bundle-id>
xcrun simctl terminate <device> <bundle-id>
xcrun simctl listapps <device>
xcrun simctl openurl <device> <url>          # deep links

# UI inspection (accessibility snapshot)
xcrun accessibility_inspector --snapshot <device>

# Touch injection (coordinate-based)
xcrun simctl io <device> enumerate           # list available IO types
# Touch events injected via simctl HID event interface
```

---

## 5. Recommendation

**Adopt Candidate C (simctl + Accessibility Snapshots) for v1, with a documented path to Candidate A for v2.**

Rationale:

1. **Fits the project philosophy** — OpenSafari uses direct CLI/protocol connections with no middleware servers. `simctl` is already in use. This extends the same pattern to native apps.
2. **Zero new build dependencies** — No Xcode project, no Swift toolchain invocation in the hot path, no forked repository.
3. **Sufficient for common automation tasks** — Element tap by accessibility label, text input, scroll, swipe, and deep-link navigation cover the majority of native-app QA scenarios.
4. **Fast startup** — LLM tool calls expect sub-second responses. The absence of a compile step is critical.
5. **Low maintenance burden** — `simctl` changes are infrequent and documented by Apple release notes.

**v2 upgrade path:** If richer gesture support (force press, multi-touch, inertial scroll) is needed, Candidate A (XCUITest Bridge) can be added as an opt-in `NativeBackend` implementation. The `AutomationBackend` abstraction proposed here explicitly supports multiple backend implementations per backend type.

---

## 6. Architecture Design

### 6.1 Backend Abstraction

A new `AutomationBackend` umbrella type groups `BrowserBackend` (existing) and the new `NativeBackend` (proposed). `SessionManager` is extended to route tool calls to the correct backend based on `BackendType`.

```
                    ┌──────────────────────────┐
                    │    AutomationBackend      │  (new umbrella type)
                    │  ┌────────────────────┐   │
                    │  │  BrowserBackend    │   │  (existing — Safari/WebKit)
                    │  └────────────────────┘   │
                    │  ┌────────────────────┐   │
                    │  │  NativeBackend     │   │  (new — native app)
                    │  └────────────────────┘   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │     SessionManager        │  (extended with BackendType)
                    │  deviceId →               │
                    │    { safari: BrowserBackend│
                    │      native: NativeBackend}│
                    └──────────────────────────┘
```

### 6.2 NativeBackend Interface (proposed)

```typescript
// src/types/native-backend.ts

export type AppState = 'running' | 'stopped' | 'installing' | 'unknown';

export interface AppInfo {
  bundleId: string;
  name: string;
  version: string;
  state: AppState;
}

export interface AccessibilityNode {
  label: string | null;
  role: string;
  value: string | null;
  frame: { x: number; y: number; width: number; height: number };
  children: AccessibilityNode[];
  traits: string[];
}

export interface NativeBackend {
  // Lifecycle
  launchApp(bundleId: string, args?: string[]): Promise<void>;
  terminateApp(bundleId: string): Promise<void>;
  listApps(): Promise<AppInfo[]>;
  getAppState(bundleId: string): Promise<AppState>;

  // Accessibility
  getAccessibilityTree(): Promise<AccessibilityNode>;
  findElement(query: { label?: string; role?: string; value?: string }): Promise<AccessibilityNode | null>;

  // Interactions (coordinate-based)
  tap(x: number, y: number): Promise<void>;
  doubleTap(x: number, y: number): Promise<void>;
  longPress(x: number, y: number, duration?: number): Promise<void>;
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, duration?: number): Promise<void>;
  typeText(text: string): Promise<void>;

  // System
  openDeepLink(url: string): Promise<void>;
  handleAlert(action: 'accept' | 'dismiss'): Promise<void>;
  setPermission(bundleId: string, permission: string, value: 'granted' | 'denied'): Promise<void>;

  // Observability
  screenshot(): Promise<Buffer>;
  getLogs(bundleId?: string): Promise<string[]>;
}
```

### 6.3 Session Routing

Each device entry in `SessionManager` is tagged with a `BackendType`:

```typescript
type BackendType = 'safari' | 'native-app';

interface DeviceSession {
  deviceId: string;
  safari?: BrowserBackend;   // present when BackendType includes 'safari'
  native?: NativeBackend;    // present when BackendType includes 'native-app'
}
```

MCP tool handlers resolve the correct backend via `SessionManager.getBackend(deviceId, type)`. Safari tools always resolve `safari`; `app_*` tools always resolve `native`.

### 6.4 Error Taxonomy Extensions

Three new `ErrorCode` values are added, following the existing `StructuredError` pattern in `src/errors/codes.ts`:

| Code | Recoverable | Suggestion |
|------|-------------|-----------|
| `ACCESSIBILITY_UNAVAILABLE` | `true` | Enable Accessibility in Simulator settings |
| `NATIVE_GESTURE_FAILED` | `true` | Verify target coordinates are within screen bounds |
| `APP_STATE_UNKNOWN` | `true` | Re-query app state; app may be launching |

---

## 7. Proposed MCP Tool Surface

All new tools use the `app_` prefix to signal native-app context and to avoid collisions with existing Safari tools.

### Session / Lifecycle

| Tool | Description |
|------|-------------|
| `app_launch` | Launch an app by bundle ID |
| `app_terminate` | Terminate a running app |
| `app_list` | List installed apps on the device |
| `app_state` | Query current foreground/background state of an app |

### Accessibility

| Tool | Description |
|------|-------------|
| `app_accessibility_tree` | Return the full accessibility UI tree as JSON |
| `app_find_element` | Find a specific UI element by label, role, or value |
| `app_element_info` | Return detailed info for an element at given coordinates |

### Interactions

| Tool | Description |
|------|-------------|
| `app_tap` | Tap at (x, y) or on an element matching a query |
| `app_type` | Type text into the focused input field |
| `app_swipe` | Swipe from one point to another |
| `app_long_press` | Long-press at (x, y) for a given duration |

### System

| Tool | Description |
|------|-------------|
| `app_permission` | Grant or deny a permission (camera, location, notifications, etc.) |
| `app_alert_handle` | Accept or dismiss a system alert dialog |
| `app_deep_link` | Open a URL that deep-links into an installed app |
| `app_notification` | Simulate receiving a push notification |

### Observability

| Tool | Description |
|------|-------------|
| `app_screenshot` | Capture a screenshot of the current simulator screen |
| `app_screen_recording` | Start/stop screen recording (returns video path) |
| `app_logs` | Return recent OS log lines for a given bundle ID |

---

## 8. Hybrid Flow Strategy

A hybrid flow is a user journey that crosses the Safari and native-app boundary on the same simulator device.

### Simultaneous Backends

A single device session can hold both a `safari` and a `native` backend simultaneously. `SessionManager` maintains both in the `DeviceSession` record. Starting a native session does not disconnect the Safari session.

### Hybrid Scenario: OAuth Deep-Link

```
1. navigate("https://example.com/login")   → BrowserBackend (Safari)
2. click("#sign-in-with-app")              → BrowserBackend (Safari)
   // Safari opens deep link → native app comes to foreground
3. app_tap(x, y)                           → NativeBackend (native app)
4. app_type("password")                    → NativeBackend
5. app_tap("Authorize")                    → NativeBackend
   // Native app redirects back to Safari via custom URL scheme
6. read_page()                             → BrowserBackend (Safari)
```

No explicit context-switch call is required because tool names determine which backend is used.

### WebView Bridging

When a native app embeds a `WKWebView`, OpenSafari can attach the existing `WebKitClient` to the WebView's debug target. The `app_accessibility_tree` tool will reveal `WebView` nodes; a subsequent call to `SessionManager.attachWebView(deviceId, webViewTargetId)` promotes that node to a full `BrowserBackend` session, enabling all 68 existing Safari tools inside the native app's WebView.

### Context Auto-Detection

Callers that need to determine which context is currently in the foreground can call `app_state` on candidate bundle IDs. A future `get_active_context()` tool may be added in M6 to make this explicit.

---

## 9. Backward Compatibility

| Concern | Impact | Mitigation |
|---------|--------|-----------|
| Existing 68 MCP tools | None | Tool registrations are unchanged; `app_*` tools are additive |
| `BrowserBackend` interface | None | Interface is extended, not modified |
| `SessionManager` API | None | New `DeviceSession` fields are optional; existing callers see no change |
| `opensafari serve` startup | None | Native backend is not initialized until a native tool is first called |
| Default tier | None | Native tools are available at tier 2+ or via `--all-tools`; tier 1 core tools are unchanged |
| Error codes | Additive | Three new codes added; no existing codes modified |

---

## 10. Scope Boundary

Native-app automation is implemented **inside OpenSafari** (not as a sister project).

Rationale:

1. **Shared simulator lifecycle** — `SimulatorManager` already handles boot, shutdown, and UDID resolution. Native and Safari backends share this lifecycle without duplication.
2. **Shared `SessionManager`** — Hybrid flows require both backends to operate on the same device session. A separate project would need to re-implement or duplicate session state.
3. **Shared error taxonomy** — `StructuredError` / `ErrorCode` applies uniformly to both backends. A single `opensafari doctor` command can diagnose issues across both.
4. **Namespace isolation** — The `app_` prefix cleanly separates native tools from Safari tools without requiring a separate binary or MCP server.

---

## 11. Milestone Breakdown

| Milestone | Scope | Linked Issues |
|-----------|-------|---------------|
| **M1** | Backend abstraction layer — `AutomationBackend` umbrella type, `BackendType` enum, `NativeBackend` interface, `SessionManager` extension | To be filed under #344 |
| **M2** | Native app lifecycle tools — `app_launch`, `app_terminate`, `app_list`, `app_state` | To be filed under #344 |
| **M3** | Accessibility tree integration — `app_accessibility_tree`, `app_find_element`, `app_element_info` | To be filed under #344 |
| **M4** | Native interaction tools — `app_tap`, `app_type`, `app_swipe`, `app_long_press` | To be filed under #344 |
| **M5** | System surface tools — `app_permission`, `app_alert_handle`, `app_deep_link`, `app_notification` | To be filed under #344 |
| **M6** | Hybrid flow support — WebView bridging, `SessionManager` dual-backend, `get_active_context()` | To be filed under #344 |
| **M7** | CI integration and documentation — update `docs/getting-started.md`, add integration tests | To be filed under #344 |

Implementation issues for M1–M7 will be filed as children of [#344](https://github.com/shaun0927/opensafari/issues/344) after this RFC is approved.

---

## 12. Open Questions

1. **Accessibility snapshot stability across Xcode versions** — The `xcrun accessibility_inspector` snapshot API is semi-private. If it breaks in a future Xcode release, what is the fallback? Candidate A (XCUITest Bridge) is the natural upgrade path, but a concrete fallback policy should be decided before M3.

2. **simctl HID touch injection API** — The exact mechanism for programmatic touch injection via `simctl` (vs. the `simctl io` enumerate command) needs a spike to confirm latency and reliability at the level required for real-time interaction tools. This should be validated in a spike document before M4.

3. **Screen recording format and streaming** — `app_screen_recording` (M5) implies either a file path or a streaming API. The preferred output format (MP4 file path returned after stop vs. MJPEG stream) is not settled. This affects both the tool API and the MCP transport.

4. **Permission grant API across iOS versions** — `simctl privacy` supports `grant`/`revoke`/`reset` but coverage varies by iOS version and permission type. A compatibility matrix should be documented before `app_permission` ships in M5.

---

## 13. References

- [Spike: Connection Method Evaluation](./spike-connection-method.md) — Prior art on how OpenSafari evaluated connection methods for Safari automation
- [Parent Epic #344](https://github.com/shaun0927/opensafari/issues/344) — Native-app automation epic
- [RFC Issue #345](https://github.com/shaun0927/opensafari/issues/345) — This RFC
- [Apple Developer: xcrun simctl](https://developer.apple.com/documentation/xcode/simctl) — Official simctl documentation
- [Apple Developer: Accessibility Inspector](https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/OSXAXTestingApps.html) — Accessibility inspection tooling
- [WebKit Remote Debugging Protocol](https://webkit.org/web-inspector/remote-debugging-protocol/) — Protocol used by existing `WebKitClient`
- [XCTest Framework](https://developer.apple.com/documentation/xctest) — Apple's official UI testing framework (Candidate A / v2 path)
