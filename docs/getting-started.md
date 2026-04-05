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
