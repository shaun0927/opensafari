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
You: Check example.com for mobile issues on iPhone SE

Claude: [Uses navigate, screenshot, qa_full_audit tools]
        Found 3 issues: auto-zoom on search input, touch target too small...
```

## Available Device Presets

```bash
opensafari devices
```

| Preset | Device | Viewport |
|--------|--------|----------|
| iphone-se | iPhone SE (3rd gen) | 375x667 |
| iphone-16 | iPhone 16 | 393x852 |
| iphone-16-pro-max | iPhone 16 Pro Max | 440x956 |
| ipad | iPad (10th gen) | 820x1180 |
| ipad-pro | iPad Pro 13-inch | 1032x1376 |

## Login Persistence

```bash
# Save auth after logging in
opensafari auth save mysite.com

# List saved profiles
opensafari auth list

# Delete a profile
opensafari auth delete mysite.com
```
