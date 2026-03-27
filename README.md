<h1 align="center">OpenSafari</h1>

<p align="center">
  <b>Smart. Fast. Parallel.</b><br>
  iOS Safari automation MCP server via Xcode Simulator.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"></a>
  <a href="https://github.com/shaun0927/opensafari"><img src="https://img.shields.io/badge/status-in--development-orange" alt="Status"></a>
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
// ~/.claude.json
{
  "mcpServers": {
    "opensafari": {
      "command": "opensafari",
      "args": ["serve"]
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

## Tools (Planned)

### Core Tools (Phase 1)

| Tool | Description |
|------|-------------|
| `navigate` | Open URL in real Safari |
| `computer` | Touch, scroll, type — coordinate-based interaction |
| `screenshot` | Capture real Safari screen via WebKit Protocol or simctl |
| `read_page` | Extract visible text content |
| `query_dom` | CSS selector queries with element details |
| `javascript` | Execute JavaScript in page context via `Runtime.evaluate` |
| `inspect` | Element CSS, accessibility, and layout inspection |
| `cookies` | Get/set/clear real Safari cookies via `Network` domain |

### Device Management (Phase 1)

| Tool | Description |
|------|-------------|
| `device_list` | List available simulator device types |
| `device_boot` | Boot a specific device (iPhone SE, 16, iPad, etc.) |
| `device_shutdown` | Shutdown simulator |
| `device_snapshot` | Save/restore simulator state (including login) |
| `device_rotate` | Toggle portrait/landscape |
| `appearance_toggle` | Switch light/dark mode via `simctl ui` |

### Parallel & Orchestration (Phase 2)

| Tool | Description |
|------|-------------|
| `batch_screenshot` | Capture same URL across all active devices |
| `batch_execute` | Run JS across all simulators in parallel |
| `batch_navigate` | Open same URL on all devices simultaneously |
| `cross_viewport_compare` | Side-by-side visual comparison across devices |

### iOS QA Engine (Phase 3)

| Tool | Description |
|------|-------------|
| `qa_auto_zoom` | Detect inputs triggering iOS auto-zoom |
| `qa_touch_targets` | Find elements below 44×44px minimum |
| `qa_safe_area` | Check content behind notch/home indicator |
| `qa_keyboard_overlap` | Detect fixed elements hidden by real keyboard |
| `qa_dark_mode` | Compare light vs dark mode rendering |
| `qa_full_audit` | Run all QA checks and generate report |

---

## Quick Start (Coming Soon)

```bash
# Prerequisites: macOS + Xcode (with iOS Simulator)

# Install
npm install -g opensafari-mcp

# Run
opensafari serve

# With specific devices
opensafari serve --devices "iphone-17e,iphone-17-pro-max"

# With auth state
opensafari serve --auth ~/.opensafari/auth/mysite.json

# Health check
opensafari doctor
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

## License

MIT

---

<p align="center">
  <b>Built for developers who ship mobile-first products.</b><br>
  <sub>By the creators of <a href="https://github.com/shaun0927/openchrome">OpenChrome</a></sub>
</p>
