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
| **Engine** | **Real Safari** (Xcode Sim) | WebKit approximation | Real devices (cloud) | Real devices |
| **iOS Fidelity** | **exact** (same WebKit) | close but diverges | exact | exact |
| **Parallel sessions** | **N simulators** | N browsers | limited by plan | 1 device |
| **Login persistence** | **built-in** (storageState) | manual | manual | manual |
| **LLM integration** | **MCP native** | none | none | none |
| **Cost** | **free** (Xcode) | free | $29+/mo | device cost |
| **CI/CD ready** | **yes** | yes | yes | no |
| **iOS-specific QA** | **auto-detect** (zoom, safe area, keyboard) | none | manual | manual |

> **tl;dr** — OpenSafari runs real Safari inside Xcode Simulator, controls it via WebKit debugging protocol, and lets AI agents perform parallel mobile QA across multiple iPhone/iPad models simultaneously — with persistent login sessions.

---

## What is OpenSafari?

Imagine testing your website on **iPhone SE, iPhone 16, iPhone 16 Pro Max, and iPad** — all at the same time, already logged in, with an AI agent that automatically detects iOS-specific bugs. That's OpenSafari.

```
You: Check omofictions.com for mobile issues across all iPhone sizes

AI:  [4 parallel simulators, all devices simultaneously]
     iPhone SE:    ⚠ grid-cols-3 cards too narrow (87px)
     iPhone 16:    ✓ Layout OK
     iPhone 16 PM: ✓ Layout OK
     iPad:         ⚠ Search bar missing at 1024px breakpoint

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
│  │ (simctl)    │  │ (playwright) │  │
│  └──────┬──────┘  └──────┬───────┘  │
│         │                │          │
│    boot/shutdown    navigate/click   │
│    snapshot         screenshot       │
│    multi-device     DOM/JS/network   │
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

OpenSafari uses the **actual Safari engine** inside Xcode Simulator — not an approximation. Every iOS-specific quirk is faithfully reproduced:

- **iOS auto-zoom** on inputs with `font-size < 16px`
- **`position: fixed`** behavior with software keyboard
- **`100vh`** viewport height inconsistencies
- **Safe area insets** (notch, home indicator)
- **`color-scheme`** dark mode forced rendering
- **Touch target** minimum size requirements (44×44px)

### 2. Parallel Multi-Device Testing

Test across multiple devices simultaneously with a single command:

```
opensafari serve --devices "iphone-se,iphone-16,iphone-16-pro-max,ipad-pro"

# 4 simulators boot in parallel
# Each gets its own Safari instance
# All share login state via storageState
```

### 3. Persistent Login Sessions

Log in once, test forever:

```
# First time: manual login captured automatically
opensafari auth save --site omofictions.com
  → Saves cookies + localStorage to ~/.opensafari/auth/omofictions.json

# Every subsequent run: auto-restored
opensafari serve
  → All simulators start already logged in
```

Built on playwright's `storageState` — cookies, localStorage, and sessionStorage all persisted across simulator restarts.

### 4. iOS-Specific Auto-Detection

OpenSafari includes built-in checks that no other tool provides:

| Check | What It Detects |
|-------|----------------|
| **Auto-Zoom Guard** | `<input>` elements with font-size < 16px |
| **Safe Area Validator** | Content hidden behind notch or home indicator |
| **Keyboard Overlap** | Fixed elements covered by software keyboard |
| **Touch Target Audit** | Clickable elements smaller than 44×44px |
| **Dark Mode Diff** | Visual differences when device dark mode is enabled |
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
| Safari Client | **NEW** | OpenSafari |
| iOS QA Engine | **NEW** | OpenSafari |

---

## Tools (Planned)

### Core Tools (Phase 1)

| Tool | Description |
|------|-------------|
| `navigate` | Open URL in Safari |
| `computer` | Touch, scroll, type — coordinate-based interaction |
| `screenshot` | Capture simulator screen (full page or viewport) |
| `read_page` | Extract visible text content |
| `query_dom` | CSS selector queries with element details |
| `javascript` | Execute JavaScript in page context |
| `inspect` | Element CSS, accessibility, and layout inspection |
| `cookies` | Get/set/clear Safari cookies |

### Device Management (Phase 1)

| Tool | Description |
|------|-------------|
| `device_list` | List available simulator device types |
| `device_boot` | Boot a specific device (iPhone SE, 16, iPad, etc.) |
| `device_shutdown` | Shutdown simulator |
| `device_snapshot` | Save/restore simulator state (including login) |
| `device_rotate` | Toggle portrait/landscape |
| `appearance_toggle` | Switch light/dark mode |

### Parallel & Orchestration (Phase 2)

| Tool | Description |
|------|-------------|
| `batch_screenshot` | Capture same URL across all active devices |
| `batch_execute` | Run JS across all simulators in parallel |
| `workflow_init` | Initialize parallel QA workflow |
| `worker_create` | Spawn isolated simulator worker |
| `cross_viewport_compare` | Side-by-side visual comparison across devices |

### iOS QA Engine (Phase 3)

| Tool | Description |
|------|-------------|
| `qa_auto_zoom` | Detect inputs triggering iOS auto-zoom |
| `qa_touch_targets` | Find elements below 44×44px minimum |
| `qa_safe_area` | Check content behind notch/home indicator |
| `qa_keyboard_overlap` | Detect fixed elements hidden by keyboard |
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
opensafari serve --devices "iphone-se,iphone-16-pro-max"

# With auth state
opensafari serve --auth ~/.opensafari/auth/mysite.json
```

---

## Requirements

- **macOS** (Xcode Simulator is macOS only)
- **Xcode** with iOS Simulator runtime installed
- **Node.js** >= 18
- **playwright** (WebKit engine)

---

## Relationship to OpenChrome

OpenSafari is the **Safari/iOS counterpart** to [OpenChrome](https://github.com/shaun0927/openchrome).

| | OpenChrome | OpenSafari |
|---|---|---|
| **Browser** | Chrome (desktop) | Safari (iOS via Simulator) |
| **Protocol** | CDP (Chrome DevTools) | WebKit Remote Debugging |
| **Engine** | puppeteer-core | playwright (WebKit) |
| **Execution** | `chrome --headless` | `xcrun simctl` |
| **Use Case** | Desktop web automation | Mobile web QA & debugging |
| **Parallel** | N tabs in 1 Chrome | N simulators |

Together, they provide **complete browser coverage** — Chrome for desktop, Safari for iOS — both controlled by AI agents through MCP.

---

## License

MIT

---

<p align="center">
  <b>Built for developers who ship mobile-first products.</b><br>
  <sub>By the creators of <a href="https://github.com/shaun0927/openchrome">OpenChrome</a></sub>
</p>
