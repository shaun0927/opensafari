# Getting Started with OpenSafari

## Prerequisites

- **macOS** (Xcode Simulator is macOS only)
- **Xcode** with iOS Simulator runtime
- **Node.js** >= 18
- **ios-webkit-debug-proxy**: `brew install ios-webkit-debug-proxy`

## Installation

```bash
npm install -g opensafari-mcp
```

## Verify Installation

```bash
opensafari doctor
```

Expected output:
```
OpenSafari Doctor

  ✓ macOS
  ✓ Xcode (v16.0)
  ✓ Simulator
  ✓ iOS Runtimes (iOS 18.0)
  ✓ Node.js >= 18 (v22.0.0)
```

## Quick Start

### 1. Start the MCP server

```bash
opensafari serve
```

### 2. Connect from Claude Code

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "opensafari": {
      "command": "opensafari",
      "args": ["serve"]
    }
  }
}
```

### 3. Use in Claude Code

```
You: Check example.com for mobile issues on iPhone 17e

Claude: [Uses navigate, screenshot, qa_full_audit tools]
        Found 3 issues: auto-zoom on search input, touch target too small...
```

## Debugging a Flutter Native App

OpenSafari can drive Flutter apps running in the iOS Simulator and inspect them
through the Dart VM Service. **How you launch the app decides what works.**

### Launch so the VM Service is reachable

The VM Service (and therefore `flutter_connect`, `flutter_widget_tree`,
`flutter_hot_reload`, synthetic pointer input, profiling, etc.) is only exposed
when the app is started with `flutter run` in a VM-enabled build mode:

```bash
# Simulator: use --debug. OpenSafari attaches and gets the full tool surface.
flutter run --debug

# Physical device: --profile keeps the VM Service while running near release perf.
flutter run --profile
```

- `xcrun simctl launch` and **release builds do not expose the VM Service** — the
  `flutter_*` inspection tools will not attach. Use the native fallback tools
  (`app_tree`, `app_tap_element`, `app_screenshot_native`, `app_logs`,
  `flutter_network`) for those.
- **`--profile` is rejected by the Flutter toolchain on simulators**
  (*"Profile mode is not supported for simulators."*). On the simulator, use
  `--debug`; reserve `--profile` for physical-device QA.

### Attach deterministically

Auto-discovery scans the simulator logs for the VM Service URL, which is
convenient but can be slow on a cold start. For repeatable runs, pin the port and
pass it to `flutter_connect`:

```bash
flutter run --debug --host-vmservice-port=50642
```

Then call `flutter_connect` with `vm_service_port: 50642` (plus
`vm_service_auth_code` if the VM Service prints an auth token), or pass the full
`vm_service_url` directly. See [Flutter VM attach](flutter-vm-attach.md) for the
attach patterns and troubleshooting.

### Which mode supports which tools

Capability depends on build mode (and Xcode version). Rather than duplicate it
here, see the
[Build-mode × Xcode tier matrix](flutter-inspector.md#build-mode--xcode-tier-matrix-596).

> Release/TestFlight builds are not VM-debuggable here — they run as release
> (AOT) builds on real devices with debugging disabled. Debug in the Simulator
> (`--debug`) or on a physical device (`--profile`); use TestFlight only for
> black-box verification.

## Available Device Presets

```bash
opensafari devices
```

| Preset | Device | Viewport | DPR | Class |
|--------|--------|----------|-----|-------|
| iphone-se-1 | iPhone SE (1st generation) | 320x568 | 2 | Small |
| iphone-se-2 | iPhone SE (2nd generation) | 375x667 | 2 | Small |
| iphone-se-3 | iPhone SE (3rd generation) | 375x667 | 2 | Small |
| iphone-17e | iPhone 17e | 390x844 | 3 | Standard |
| iphone-17 | iPhone 17 | 402x874 | 3 | Standard |
| iphone-air | iPhone Air | 420x912 | 3 | Standard |
| iphone-17-pro | iPhone 17 Pro | 402x874 | 3 | Standard |
| iphone-17-pro-max | iPhone 17 Pro Max | 440x956 | 3 | Large |
| ipad-air | iPad Air 13-inch (M4) | 1024x1366 | 2 | Tablet |
| ipad-pro | iPad Pro 13-inch (M5) | 1032x1376 | 2 | Tablet |

For the device preset accuracy table with verification dates, see [Device Preset Accuracy](device-presets.md).

## Login Persistence

```bash
# Save auth after logging in
opensafari auth save mysite.com

# List saved profiles
opensafari auth list

# Delete a profile
opensafari auth delete mysite.com
```

Saved auth profiles live in `~/.opensafari/auth/` as one JSON file per site, such as `~/.opensafari/auth/mysite.com.json`. A profile stores the site name, saved timestamp, current URL, cookies, cookie domain groups, localStorage, and sessionStorage so later runs can restore the login state. On POSIX systems, newly saved profiles use private directory and file permissions (`0700` for the auth directory, `0600` for profile JSON files) and profile updates are written atomically.

To remove stored login state, run `opensafari auth delete mysite.com` or delete the matching JSON file from `~/.opensafari/auth/`.
