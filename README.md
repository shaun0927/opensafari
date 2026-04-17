<h1 align="center">OpenSafari</h1>

<p align="center">
  <b>Smart. Fast. Parallel.</b><br>
  iOS Safari automation MCP server via Xcode Simulator.
</p>

<p align="center">
  <b>Headless mobile QA automation</b> — drive real Safari, Flutter, and native iOS apps on Xcode Simulator without stealing your mouse or requiring Simulator.app focus.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opensafari-mcp"><img src="https://img.shields.io/npm/v/opensafari-mcp.svg" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"></a>
  <a href="https://github.com/shaun0927/openchrome"><img src="https://img.shields.io/badge/sibling-OpenChrome-blue" alt="OpenChrome"></a>
</p>

---

### How OpenSafari compares

|  | OpenSafari | Playwright WebKit | BrowserStack | Manual Testing |
|---|:---:|:---:|:---:|:---:|
| **Engine** | **Real Safari** (Xcode Sim) | Bundled WebKit (approximation) | Real devices (cloud) | Real devices |
| **Protocol** | **WebKit Remote Debugging** (direct) | Playwright API (wrapper) | Proprietary | N/A |
| **iOS Fidelity** | **exact** | close but diverges | exact | exact |
| **Parallel sessions** | **N simulators** | N browsers | limited by plan | 1 device |
| **Login persistence** | **built-in** (real Safari cookies) | manual | manual | manual |
| **LLM integration** | **MCP native** | none | none | none |
| **Cost** | **free** (Xcode) | free | $29+/mo | device cost |
| **iOS-specific QA** | **auto-detect** (zoom, safe area, keyboard) | none | manual | manual |

> **tl;dr** — OpenSafari controls the **real Safari** inside Xcode Simulator via WebKit Remote Debugging Protocol — the same way [OpenChrome](https://github.com/shaun0927/openchrome) controls real Chrome via CDP. No middleware, no bundled browsers. Just direct protocol access to the actual Safari.app.

---

## Headless Capabilities

OpenSafari runs fully headless on CI — no display server, no mouse focus, no `Simulator.app` window required. See [docs/headless-architecture.md](docs/headless-architecture.md) for the full technical design.

| Scenario | Query (AX Tree) | Input (Tap/Type) | Headless | Backend |
|---|---|---|---|---|
| Safari (Web) | ✅ | ✅ | ✅ | WebKit Remote Debug |
| Flutter App | ✅ | ✅ | ✅ | FlutterVMInputBackend |
| Native iOS App (Xcode ≤ 16) | ✅ | ✅ | ✅ | SimulatorKitHID (Tier 1) / `simctl` |
| Native iOS App (Xcode 26+, element-targeted `app_tap_element` / `app_type_element`) | ✅ | ✅ | ✅ | AX-press (Tier 1.5) when the element advertises `AXPress` — see [docs/headless-architecture.md](docs/headless-architecture.md) |
| Native iOS App (Xcode 26+, coordinate `app_tap({x,y})` / `app_swipe_native`) | ✅ | ⚠️ Experimental (opt-in) | ⚠️ | PointerService opt-in via `OPENSAFARI_ENABLE_POINTERSERVICE=1` — see [#590](https://github.com/shaun0927/opensafari/issues/590); AppleScript fallback otherwise ([#491](https://github.com/shaun0927/opensafari/issues/491)) |
| WebView in Native | ✅ | ⚠️ Partial | ⚠️ | WebKit + Native |

> ✅ Supported and stable. ⚠️ Partially supported — see linked docs for current status and limitations.

Stability commitments (stable vs opt-in vs experimental) are catalogued in [docs/simhid-ios26-investigation.md#stability-commitments](docs/simhid-ios26-investigation.md#stability-commitments).

### Headless input vs other iOS automation tools

|  | OpenSafari | Appium | idb | XCUITest |
|---|:---:|:---:|:---:|:---:|
| **Headless native input** (no mouse focus, no `Simulator.app` activation) | **✅ AX-press + SimulatorKit HID** (element-targeted tap & keys/buttons headless on Xcode 26+; coordinate-only tap/swipe pending [#491](https://github.com/shaun0927/opensafari/issues/491)) | ❌ ([XCUI focus](https://appium.io/docs/en/2.0/ecosystem/drivers/)) | ✅ `FBSimulatorHID` | ❌ |
| **Works on Xcode 26+** (after `simctl io input` removal) | ✅ Safari, Flutter, and element-targeted native taps; ⚠️ coordinate-only native tap/swipe pending | ⚠️ driver-dependent | ✅ | ✅ |
| **Flutter native taps** (no OS-level input) | ✅ Dart VM `PointerDataPacket` | ⚠️ 3rd-party plugin | ❌ | ❌ |
| **MCP / LLM integration** | ✅ native | ❌ | ❌ | ❌ |
| **Private API dependency** | SimulatorKit (documented, sentinel-guarded) | UIAutomation / XCUI | SimulatorKit | none |

> See [docs/private-apis.md](docs/private-apis.md) for the SimulatorKit contract, the daily sentinel CI that detects BC breaks, and the rollback plan if Apple changes symbols.

For CI setup recipes (GitHub Actions, Buildkite, GitLab CI), see [docs/ci-recipes.md](docs/ci-recipes.md).

Long-running MCP sessions are soak-tested nightly — see [memory-soak workflow](.github/workflows/memory-soak.yml).

---

## What is OpenSafari?

Imagine testing your e-commerce site on **iPhone 17e, iPhone 17, iPhone 17 Pro Max, and iPad** — all at the same time, already logged in, with an AI agent that automatically finds iOS-specific bugs. That's OpenSafari.

```
You: Check our checkout flow for mobile issues across all iPhone sizes

AI:  [4 parallel simulators, all devices simultaneously]
     iPhone 17e:      ⚠ Credit card input triggers iOS auto-zoom (font-size: 14px)
     iPhone 17:       ✓ Layout OK
     iPhone 17 PM:    ⚠ "Place Order" button only 38×32px (below 44px touch target)
     iPad:            ⚠ Shipping form hidden behind keyboard when focused

     Time: 8s | All screenshots captured and analyzed.
```

| | Manual QA | OpenSafari |
|---|:---:|:---:|
| **4-device test** | ~30 min | **~10s** (parallel) |
| **Login** | Each device, each time | **Never** (persisted) |
| **iOS bug detection** | Human eye | **Automatic** (LLM vision) |
| **Consistency** | Varies by tester | **Deterministic** |

---

## Core Architecture

OpenSafari follows the same direct-protocol philosophy as OpenChrome:

```
OpenChrome:  CDPClient → Chrome DevTools Protocol → Real Chrome
OpenSafari:  SafariClient → WebKit Remote Debugging Protocol → Real Safari in Simulator
```

No middleware. No bundled browsers. Direct connection.

```
Claude Code / AI Agent (MCP Client)
    │
    │  JSON-RPC (stdio / HTTP)
    ▼
┌─────────────────────────────────────┐
│         OpenSafari MCP Server       │
│                                     │
│  ┌─────────────┐  ┌──────────────┐  │
│  │ Simulator   │  │ Safari       │  │
│  │ Manager     │  │ Client       │  │
│  │ (simctl)    │  │ (WebKit      │  │
│  │             │  │  Protocol)   │  │
│  └──────┬──────┘  └──────┬───────┘  │
│         │                │          │
│    boot/shutdown    navigate/click   │
│    rotate/appear    screenshot       │
│    multi-device     DOM/JS/cookies   │
│         │                │          │
│  ┌──────▼────────────────▼───────┐  │
│  │     Xcode Simulator(s)       │  │
│  │  ┌────────┐  ┌────────┐      │  │
│  │  │ iPhone │  │ iPhone │ ...  │  │
│  │  │ SE     │  │ 16 PM  │      │  │
│  │  │ Safari │  │ Safari │      │  │
│  │  └────────┘  └────────┘      │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  Shared Infrastructure      │    │
│  │  (from OpenChrome)          │    │
│  │  • Security (sanitizer,     │    │
│  │    domain guard, audit)     │    │
│  │  • Watchdog (event loop,    │    │
│  │    disk, health endpoint)   │    │
│  │  • Orchestration (workflow  │    │
│  │    engine, parallel workers)│    │
│  │  • Session persistence      │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

---

## Key Features

### 1. Real Safari, Real Bugs

OpenSafari controls the **actual Safari.app** inside Xcode Simulator via WebKit Remote Debugging Protocol — not a bundled approximation. Every iOS-specific quirk is faithfully reproduced:

- **iOS auto-zoom** on inputs with `font-size < 16px`
- **`position: fixed`** behavior with real software keyboard
- **`100vh`** viewport height inconsistencies with address bar
- **Safe area insets** (notch, home indicator) on real device frames
- **`color-scheme`** dark mode forced rendering
- **Touch target** minimum size requirements (44×44px)

### 2. Parallel Multi-Device Testing

Test across multiple devices simultaneously with a single command:

```
opensafari serve --devices "iphone-17e,iphone-17,iphone-17-pro-max,ipad-pro"

# 4 simulators boot in parallel
# Each gets its own Safari instance + WebKit Protocol connection
# All share login state via cookie injection
```

### 3. Persistent Login Sessions

Log in once, test forever. Cookies and localStorage are extracted directly from the real Safari session:

```
# First time: login captured from real Safari
opensafari auth save --site myapp.com
  → Exports cookies via WebKit Protocol Network.getAllCookies
  → Saves to ~/.opensafari/auth/myapp.json

# Every subsequent run: auto-restored
opensafari serve
  → Injects cookies via Network.setCookie into each simulator's Safari
  → All simulators start already logged in
```

### 4. iOS-Specific Auto-Detection

Built-in QA checks that run on real Safari — no approximation:

| Check | What It Detects |
|-------|----------------|
| **Auto-Zoom Guard** | `<input>` elements with font-size < 16px |
| **Safe Area Validator** | Content hidden behind notch or home indicator |
| **Keyboard Overlap** | Fixed elements covered by real software keyboard |
| **Touch Target Audit** | Clickable elements smaller than 44×44px |
| **Dark Mode Diff** | Visual differences via `simctl ui appearance` toggle |
| **Viewport Compare** | Layout breaks across different screen sizes |
| **Scroll Lock Check** | Body scroll not restored after modal close |

### 5. MCP Native

Works with any MCP client — Claude Code, Cursor, VS Code, or custom agents:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "opensafari": {
      "command": "npx",
      "args": ["-y", "opensafari-mcp", "serve"]
    }
  }
}
```

### 6. Shared DNA with OpenChrome

OpenSafari shares battle-tested infrastructure with [OpenChrome](https://github.com/shaun0927/openchrome):

| Module | Source | Status |
|--------|--------|--------|
| MCP Server core | OpenChrome | Shared |
| Transport (stdio/HTTP) | OpenChrome | Shared |
| Security (sanitizer, guard, audit) | OpenChrome | Shared |
| Watchdog (event loop, disk, health) | OpenChrome | Shared |
| Orchestration (workflow engine) | OpenChrome | Adapted |
| Simulator Manager | **NEW** | OpenSafari |
| Safari Client (WebKit Protocol) | **NEW** | OpenSafari |
| iOS QA Engine | **NEW** | OpenSafari |

---

## Tools

### Core Tools (Tier 1)

| Tool | Description |
|------|-------------|
| `navigate` | Open URL in real Safari |
| `click` | Tap element by CSS selector or coordinates |
| `type` | Type text into form elements |
| `scroll` | Scroll page in any direction |
| `screenshot` | Capture real Safari screen via WebKit Protocol |
| `read_page` | Extract visible text content |
| `query_dom` | CSS selector queries with element details |
| `javascript` | Execute JavaScript in page context via `Runtime.evaluate` |
| `inspect` | Element CSS, accessibility, and layout inspection |
| `cookies` | Get/set/clear real Safari cookies via `Network` domain |

### Device Management (Tier 1)

| Tool | Description |
|------|-------------|
| `device_list` | List available simulator device types |
| `device_boot` | Boot a specific device (iPhone SE, 16, iPad, etc.) |
| `device_shutdown` | Shutdown simulator |
| `device_rotate` | Toggle portrait/landscape |
| `appearance_toggle` | Switch light/dark mode via `simctl ui` |

### App Lifecycle (Tier 2)

| Tool | Description |
|------|-------------|
| `app_launch` | Launch app by bundle ID with optional args and env vars |
| `app_terminate` | Terminate a running app by bundle ID |
| `app_activate` | Bring app to foreground (launches if not running) |
| `app_list_running` | List running foreground apps with PIDs |
| `app_reset` | Reset app state: terminate, clear permissions, uninstall |

### Auth Tools (Tier 3)

| Tool | Description |
|------|-------------|
| `auth_save` | Capture cookies + localStorage from current session |
| `auth_restore` | Restore saved auth state into a simulator |
| `auth_list` | List saved auth profiles |

### Parallel & Orchestration (Tier 2)

| Tool | Description |
|------|-------------|
| `batch_screenshot` | Capture same URL across all active devices |
| `batch_execute` | Run JS across all simulators in parallel |
| `batch_navigate` | Open same URL on all devices simultaneously |
| `cross_viewport_compare` | Side-by-side visual comparison across devices |

### iOS QA Engine (Tier 3)

| Tool | Description |
|------|-------------|
| `qa_auto_zoom` | Detect inputs triggering iOS auto-zoom |
| `qa_touch_targets` | Find elements below 44×44px minimum |
| `qa_safe_area` | Check content behind notch/home indicator |
| `qa_keyboard_overlap` | Detect fixed elements hidden by real keyboard |
| `qa_dark_mode` | Compare light vs dark mode rendering |
| `qa_full_audit` | Run all QA checks and generate report |

---

## Flutter QA Workflow

OpenSafari drives Flutter apps running in the iOS Simulator using the same native-app tools used for UIKit/SwiftUI. The only wrinkle is that **Flutter's accessibility tree is lazy** — it only populates when an assistive technology (VoiceOver, XCTest) connects. OpenSafari auto-activates it so widget labels are queryable.

### Auto-activation (no app changes required)

`app_tree`, `app_query`, `app_inspect`, `app_tap_element`, `app_wait_for`, and `app_assert_element` all call `ensureSemanticsActive()` before reading the accessibility tree. The activator:

1. Quick-checks the tree — if it already has ≥5 nodes, semantics is already active.
2. Toggles `com.apple.Accessibility.AccessibilityEnabled` via `xcrun simctl spawn defaults write` — this triggers Flutter's `SemanticsBinding` without enabling VoiceOver spoken feedback.
3. Polls the tree (up to 3s) until it populates, or falls back gracefully if activation never succeeds.

### Recommended workflow

```ts
// 1. Boot simulator and launch the Flutter app
await device_boot('iPhone 16');
await app_launch({ bundleId: 'com.example.flutterApp' });

// 2. Terminate Safari if it's running — its background elements can
//    dominate the macOS AX tree and hide Flutter widgets.
await app_terminate({ bundleId: 'com.apple.mobilesafari' });
await app_switch_app({ bundleId: 'com.example.flutterApp' });

// 3. Read the tree — Flutter Semantics nodes appear automatically.
const tree = await app_tree({ max_depth: 5 });

// 4. Query widgets by label, identifier, or role.
const button = await app_query({ label: 'Login' });
const email  = await app_query({ identifier: 'email-field' });
```

### Making widgets queryable

| Flutter API | Queryable via | Notes |
|-------------|----------------|-------|
| `Semantics(label: 'Login')` | `app_query({ label: 'Login' })` | Preferred for human-readable labels |
| `Semantics(identifier: 'login-btn')` | `app_query({ identifier: 'login-btn' })` | Flutter 3.19+ — stable selector for tests |
| Plain `Text('Counter: 42')` | `app_query({ text: 'Counter' })` | Works when the text widget auto-synthesizes semantics |
| `Key('login-btn')` | **Not queryable** | Keys are a Flutter-internal reference — they do **not** surface to the native AX tree |

### Release builds

Approach A (simctl defaults write) works for both debug and release builds. If a release app still reports an empty tree, add the explicit opt-in to `main.dart`:

```dart
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SemanticsBinding.instance.ensureSemantics(); // enable for OpenSafari QA
  runApp(const MyApp());
}
```

For debug/profile builds, `flutter_connect` + `flutter_widget_tree` additionally expose the Dart VM Service, which returns the full Flutter widget hierarchy (including render-tree nodes that never reach the native AX bridge).

See [docs/troubleshooting.md](docs/troubleshooting.md) for common failure modes (empty trees, missing labels, Safari shadowing).

---

## Quick Start

```bash
# Install
npm install -g opensafari-mcp

# Run (stdio mode — for MCP clients like Claude Code)
opensafari serve

# HTTP mode
opensafari serve --http 3100

# With all tool tiers exposed
opensafari serve --all-tools

# With specific devices auto-booted
opensafari serve --devices "iphone-17e,iphone-17-pro-max"

# With auth state
opensafari serve --auth ~/.opensafari/auth/mysite.json
```

### MCP Client Configuration

```jsonc
// Claude Code: .mcp.json
{
  "mcpServers": {
    "opensafari": {
      "command": "npx",
      "args": ["-y", "opensafari-mcp", "serve"]
    }
  }
}
```

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "opensafari": {
      "command": "npx",
      "args": ["-y", "opensafari-mcp", "serve", "--all-tools"]
    }
  }
}
```

### Tool Tiers

Tools are organized into 3 tiers for progressive disclosure:

| Tier | Tools | Access |
|------|-------|--------|
| **Tier 1** | navigate, screenshot, click, type, scroll, read_page, query_dom, javascript, cookies, device_boot, device_shutdown, device_list | Default |
| **Tier 2** | inspect, wait_for, press, swipe, long_press, batch_navigate, batch_screenshot, cross_viewport_compare | `setTier(2)` |
| **Tier 3** | auth_save, auth_restore, auth_list, qa_audit, qa_* detectors, workflow_init, appearance_toggle | `--all-tools` |

---

## Programmatic API

```typescript
import { createServer } from 'opensafari-mcp';

// Create and start the MCP server
const server = createServer({
  tier: 3,          // expose all tool tiers
  auditLog: true,   // enable tool call logging
});

// Start with stdio transport (default)
await server.start();

// Or start with HTTP transport
await server.start({ transport: 'http', port: 3100 });
```

### WebKitClient

Direct WebKit protocol access for custom automation:

```typescript
import { WebKitClient } from 'opensafari-mcp';

const client = new WebKitClient({ host: 'localhost', port: 9322 });
await client.connect({ retries: 5, retryDelay: 2000 });

// Navigate and evaluate
await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
const title = await client.evaluate<string>('document.title');

// Screenshot (returns PNG buffer)
const png = await client.screenshot();

// Cookies
const cookies = await client.getCookies();
await client.setCookies([{ name: 'key', value: 'val', domain: '.example.com',
  path: '/', expires: -1, httpOnly: false, secure: false }]);

// DOM interaction
await client.click('#submit-btn');
await client.type('#email-input', 'user@example.com');

await client.disconnect();
```

### SimulatorManager

Programmatic simulator lifecycle control:

```typescript
import { SimulatorManager } from 'opensafari-mcp';

const manager = new SimulatorManager();

// Boot a device
const device = await manager.boot('iPhone 17 Pro');
console.log(device.udid, device.state); // "XXXX-..." "Booted"

// Open Safari
await manager.openUrl(device.udid, 'https://example.com');

// List booted devices
const booted = await manager.listBooted();

// Shutdown
await manager.shutdown(device.udid);
```

---

## Requirements

- **macOS** (Xcode Simulator is macOS only)
- **Xcode** with iOS Simulator runtime installed
- **Node.js** >= 18
- **ios-webkit-debug-proxy** — `brew install ios-webkit-debug-proxy`

---

## WebInspector Proxy Configuration

OpenSafari uses `ios_webkit_debug_proxy` to bridge WebKit Remote Debugging from Xcode Simulator. The proxy is **auto-started** by the `device_boot` tool — no manual setup is needed in most cases.

### Default Ports

| Port | Purpose |
|------|---------|
| **9321** | Device list (HTML) — serves the proxy's device listing page |
| **9322** | Device connection (JSON) — WebKit debugging targets for connected simulators |

Port 9322 is deliberately offset from Chrome DevTools (9222) so OpenSafari and [OpenChrome](https://github.com/shaun0927/openchrome) can run simultaneously.

### Custom Port

Set the `OPENSAFARI_PROXY_PORT` environment variable to use a different device port:

```bash
# Use port 9500 instead of the default 9322
OPENSAFARI_PROXY_PORT=9500 opensafari serve
```

Port resolution order:
1. Explicit `port` option (programmatic use)
2. `OPENSAFARI_PROXY_PORT` environment variable
3. Default: **9322**

### Multi-Session Usage

Multiple Claude Code sessions can share the same proxy. When a session detects a healthy proxy already running on its target port, it reuses it instead of starting a new one. When the owning session exits, only its own proxy is terminated — other sessions' proxies remain unaffected.

---

## Input Backend Selection

OpenSafari dispatches native input (`app_tap`, `app_swipe_native`,
`app_scroll_native`, `app_double_tap`, `app_type_text`, `app_key_input`)
through a 5-tier fallback chain and surfaces the selected path in each tool
result via a `backend` field.

| Tier | Backend | Identifier | Headless? | When used |
|------|---------|------------|-----------|-----------|
| 0 | `FlutterVMInputBackend` | `flutter-vm` | Yes | Flutter app reachable over Dart VM Service + DDS |
| 1 | `SimulatorKitHIDInputBackend` | `simhid` | Yes | Any app — `sim-hid-bridge` resolves and `SimulatorKit.framework` loads (covers Xcode 26+) |
| 2 | `SimctlInputBackend` | `simctl` | Yes | Xcode ≤16 legacy path (where `simctl io input` is still available) |
| 3 | `WebKitInputBackend` | `webkit` | Yes | Xcode 26+ with an active Safari / WebView connection |
| 4 | `AppleScriptInputBackend` | `applescript` | **No** | Opt-in only — moves the mouse cursor and activates Simulator.app |

See [docs/headless-architecture.md](docs/headless-architecture.md) for the
decision flowchart and the full scenario matrix. Tool responses also include
`_meta: { backendKind, headless, deviceId }` so CI can assert
`_meta.headless === true`.

Example tool result:

```json
{
  "status": "tapped",
  "x": 100,
  "y": 200,
  "deviceId": "…",
  "backend": "simhid",
  "_meta": { "backendKind": "simhid", "headless": true, "deviceId": "…" }
}
```

### Focus-theft protection (`OPENSAFARI_ALLOW_FOCUS_INPUT`)

Tier 3 is **default-deny**. On Xcode 26+ with no Safari connection,
`getInputBackend()` throws `HeadlessInputUnavailableError` instead of
silently moving the physical mouse cursor. To re-enable the legacy
AppleScript/CGEvent fallback (for example, to automate a non-Safari native
app), opt in with an environment variable:

```bash
# Only set this if you understand the consequences — it WILL move your
# mouse cursor and bring Simulator.app to the foreground.
OPENSAFARI_ALLOW_FOCUS_INPUT=1 opensafari serve
```

Accepted values are `1` and `true`; anything else is ignored. When the
opt-in is honored, a one-time warning is logged to stderr at the first
tool call.

---

## Relationship to OpenChrome

OpenSafari is the **Safari/iOS counterpart** to [OpenChrome](https://github.com/shaun0927/openchrome). Same philosophy, same architecture — different browser.

| | OpenChrome | OpenSafari |
|---|---|---|
| **Browser** | Real Chrome | Real Safari (in Simulator) |
| **Protocol** | Chrome DevTools Protocol (CDP) | WebKit Remote Debugging Protocol |
| **Client** | CDPClient (puppeteer-core) | SafariClient (WebKit Protocol) |
| **Execution** | `chrome --remote-debugging-port` | `xcrun simctl` + WebKit debug socket |
| **Use Case** | Desktop web automation | Mobile web QA & debugging |
| **Parallel** | N tabs in 1 Chrome | N simulators, each with Safari |
| **Login** | Real Chrome sessions | Real Safari sessions |

Together, they provide **complete browser coverage** — Chrome for desktop, Safari for iOS — both controlled by AI agents through MCP with direct protocol connections. No middleware, no bundled browsers.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Setup guide and first steps |
| [API Reference](docs/api-reference.md) | Programmatic API documentation |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [CI Integration](docs/ci-integration.md) | Using OpenSafari in CI pipelines |
| [CI Recipes](docs/ci-recipes.md) | Copy-paste GitHub Actions, Buildkite, and GitLab CI recipes |
| [Memory Budget](docs/memory-budget.md) | Per-cache retention budgets and eviction policies |
| [Diagnose Tool Reference](docs/diagnose.md) | `diagnose` output schema and memory block reference |
| [RFC: Native App Backend](docs/rfc-native-app-backend.md) | Architecture RFC for native-app automation in Xcode Simulator |
| [Native App Tool Surface](docs/native-app-tool-surface.md) | Proposed MCP tool surface for native-app automation |
| [WebKit Protocol Research](docs/webkit-protocol-research.md) | WebKit Remote Debugging Protocol research notes |

---

## License

MIT

---

<p align="center">
  <b>Built for developers who ship mobile-first products.</b><br>
  <sub>By the creators of <a href="https://github.com/shaun0927/openchrome">OpenChrome</a></sub>
</p>
