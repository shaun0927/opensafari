# Headless Input Architecture

opensafari provides multiple input backends for injecting touch, keyboard, and
button events into iOS Simulator without stealing focus or moving the mouse cursor.

## What is Headless Input?

"Headless" means the input injection:

- **Does not move the physical mouse cursor** on the host Mac
- **Does not require Simulator.app to be in the foreground** (the window can be
  minimized or hidden behind other apps)
- **Works in CI environments** (GitHub Actions, etc.) where no GUI session is active

This is critical for CI/CD pipelines where parallel test runs must not interfere
with each other.

## Input Backend Tiers

`getInputBackend()` in `src/tools/native-input-backend.ts` selects a backend
using the following priority order. Each tier is tried in sequence; the first
available backend wins.

| Tier | Backend | Target Apps | Headless | Xcode 26+ | Notes |
|------|---------|-------------|----------|-----------|-------|
| 0 | `FlutterVMInputBackend` | Flutter debug/profile | Yes | Yes | Dart VM Service pointer injection |
| 1 | `SimulatorKitHIDInputBackend` | **All native apps** | Yes | Yes | Private API via `sim-hid-bridge` (#483) |
| 2 | `SimctlInputBackend` | All apps | Yes | **No** (removed) | `xcrun simctl io input` |
| 3 | `WebKitInputBackend` | Safari web content only | Yes | Yes | WebKit Remote Debug JS touch |
| 4 | `AppleScriptInputBackend` | All apps | **No** | Yes | CGEvent — steals focus, opt-in only |

### Tier 0: Flutter VM Input

For Flutter apps running in debug or profile mode, pointer events are injected
directly into the Dart isolate via the VM Service protocol. This completely
bypasses OS-level input and is the fastest path. Only available when a Flutter
debug session is detected.

### Tier 1: SimulatorKit HID (issue #483)

Uses Apple's private `SimulatorKit.framework` to inject raw HID events into the
simulator device. This is the same mechanism that `Simulator.app` itself uses to
translate mouse clicks into iOS touch events.

**Architecture:**
```
Node.js (app_tap_element)
    └── spawn dist/sim-hid-bridge <udid> tap <x> <y>
            └── dlopen SimulatorKit.framework
            └── SimDeviceLegacyHIDClient.send(message:)
            └── IndigoHIDMessageForMouseNSEvent (touch)
            └── IndigoHIDMessageForKeyboardArbitrary (key)
            └── IndigoHIDMessageForButton (home/lock/volume)
```

The Swift helper (`src/native/sim-hid-bridge.swift`) is compiled to a standalone
binary at build time. All private symbols are resolved via `dlopen`/`dlsym` at
runtime with nil-checks; missing symbols exit 78 so the Node wrapper falls
through to Tier 2.

See `docs/private-apis.md` for the private API dependency inventory and
BC-break monitoring strategy.

### Tier 2: simctl Input

Uses `xcrun simctl io <device> input tap/swipe/text/keypress`. This was the
standard headless path through Xcode 16 but **was removed in Xcode 26**.

### Tier 3: WebKit Input

Injects JavaScript touch events via the WebKit Remote Debugging Protocol.
Only works for Safari web content — not for native app UI.

### Tier 4: AppleScript / CGEvent (Default-Deny)

Synthesizes macOS mouse events via `osascript` and `CGEvent`. This **moves the
physical mouse cursor** and **activates Simulator.app** in the foreground.

**Default-deny since v0.4.0** (issue #405). Must be explicitly enabled via:
```bash
export OPENSAFARI_ALLOW_FOCUS_INPUT=1
```

Without this env var, `getInputBackend()` throws `HeadlessInputUnavailableError`
instead of silently stealing focus.

## Fallback Chain

```
getInputBackend(deviceId)
  ├── Flutter VM detected?        → Tier 0 (FlutterVM)
  ├── sim-hid-bridge available?   → Tier 1 (SimulatorKit HID)
  ├── simctl io input works?      → Tier 2 (simctl)
  ├── WebKit context active?      → Tier 3 (WebKit)
  ├── ALLOW_FOCUS_INPUT=1?        → Tier 4 (AppleScript)
  └── else                        → HeadlessInputUnavailableError
```

## Related Files

| File | Purpose |
|------|---------|
| `src/tools/native-input-backend.ts` | Routing logic, all backend classes |
| `src/tools/sim-hid-input-backend.ts` | Node wrapper for sim-hid-bridge |
| `src/native/sim-hid-bridge.swift` | Swift HID injection helper |
| `docs/private-apis.md` | Private API inventory and BC-break policy |

## Related Issues

- #483 — SimulatorKitHIDInputBackend epic
- #484 — Full headless automation epic
- #405 — Default-deny AppleScript backend
