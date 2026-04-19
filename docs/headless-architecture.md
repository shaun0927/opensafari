# Headless Architecture

This document describes how OpenSafari achieves headless iOS automation — no mouse
stealing, no `Simulator.app` window focus, CI-clean — and how it selects the right
input backend for each situation.

---

## 1. Overview

OpenSafari is a headless mobile QA automation tool. It drives Safari and native iOS
apps running inside Xcode Simulator via WebKit Remote Debugging Protocol and the
Accessibility framework. "Headless" means:

- **No mouse-cursor movement** — the physical cursor stays where it is.
- **No Simulator.app activation** — CI agents do not steal focus from other
  processes.
- **No screen required** — all interaction happens over TCP sockets and IPC
  channels, so the tool runs equally well in a headless CI VM.

These guarantees are enforced by the input-backend tier system. The non-headless
`AppleScriptInputBackend` path is default-deny and requires an explicit opt-in.

---

## 2. Input Backend Tier Routing

Native input tools (`app_tap`, `app_swipe_native`, `app_scroll_native`,
`app_double_tap`, `app_type_text`, `app_key_input`) are dispatched through a
5-tier fallback chain defined in `src/tools/native-input-backend.ts`.

### Routing table

| Tier | Backend | `kind` | Target apps | Headless | Xcode 26+ | Selection Condition | Status |
|------|---------|--------|-------------|----------|-----------|---------------------|--------|
| 0 | `FlutterVMInputBackend` | `flutter-vm` | Flutter only | Yes | Yes | Flutter VM Service reachable within 1.5 s discovery timeout | Production |
| 1 (opt-in) | `PointerServiceInputBackend` | `pointer-service` | Any app (tap on Xcode 26+) | Yes | Yes | Activated only when `OPENSAFARI_ENABLE_POINTERSERVICE=1`. Shells out to `sim-hid-bridge tap-ps` so the mouse-down/up is bracketed with `IndigoHIDMessageToCreatePointerService` / `RemovePointerService`. Swipe and keys delegate to the Tier-1 SimHID path. Phase 1 of [#590](https://github.com/shaun0927/opensafari/issues/590). | **Opt-in experimental** |
| 1 | `SimulatorKitHIDInputBackend` | `simhid` | Any app | Yes | Partial | `sim-hid-bridge` binary resolves and `SimulatorKit.framework` loads via `dlopen`. **Tap/swipe routing is currently disabled** on Xcode 26+ — see note below. Keyboard and hardware-button synthesis still route through this tier. | Partial (tap/swipe disabled on Xcode 26+) |
| 1.5 | `AccessibilityPressInputBackend` (AX press) | `ax-press` | Any app (element-targeted only) | Yes | Yes | Used by `app_tap_element` / `app_type_element` when the resolved element advertises `AXPress`. Coordinate-only `app_tap({x, y})` cannot use this tier. Disabled via `OPENSAFARI_DISABLE_AX_PRESS=1`. | Production |
| 2 | `SimctlInputBackend` | `simctl` | Any app | Yes | **Removed** | `xcrun simctl io input` probe succeeds (Xcode ≤ 16) | Legacy |
| 3 | `WebKitInputBackend` | `webkit` | Safari / WebView | Yes | Yes | Active or reconnectable WebKit connection present | Production |
| 4 | `AppleScriptInputBackend` | `applescript` | Any app | **No** | Yes | Opt-in only (`OPENSAFARI_ALLOW_FOCUS_INPUT=1`); throws `HeadlessInputUnavailableError` otherwise | Legacy / opt-in |

Tier 0 (`FlutterVMInputBackend`) ships production-ready for Flutter apps
launched under `flutter run` with the Dart VM Service (and DDS) enabled.
Tier 1 (`SimulatorKitHIDInputBackend`) `dlopen`s `SimulatorKit.framework` at
runtime and is the only path that survives `simctl io input` removal. See
[`docs/private-apis.md`](private-apis.md) for the private-framework contract.

> **Tier 1 tap/swipe — temporarily disabled on Xcode 26+.** As of
> [#537](https://github.com/shaun0927/opensafari/pull/537), `getInputBackend()`
> no longer returns `SimulatorKitHIDInputBackend` for tap/swipe operations:
> `IndigoHIDMessageForMouseNSEvent` in SimulatorKit is broken on Xcode 26 /
> iOS 26 — routed touches are consumed by the system gesture recogniser and
> the simulator screen goes black instead of delivering a tap. Digitizer,
> pointer-service, and pre-registered-pointer variants all reproduce the same
> device-lock symptom. `sim-hid-bridge` is still probed and cached (so
> `kind === 'simhid'` appears in `diagnose` output), and keyboard (`key`) plus
> hardware-button (`button`) injection still use it — only tap/swipe fall
> through to the next tier. Integration coverage is tracked in
> [#491](https://github.com/shaun0927/opensafari/issues/491); the tier flip
> back to "Production" will land the day Apple fixes the mouse-event pipeline
> or we finish a replacement touch path.

> **Practical impact on Xcode 26+.** Native (non-Flutter) taps and swipes now
> fall through Tier 0 → Tier 1 (skipped for tap/swipe) → Tier 2 (removed on
> Xcode 26+) → Tier 3 (only when a WebKit client is attached) → Tier 4 (opt-in
> AppleScript). On stock Xcode 26 this means native app taps require either
> `set_active_context({ context: 'safari' })` for a WebKit path or
> `OPENSAFARI_ALLOW_FOCUS_INPUT=1` for the focus-stealing fallback. Flutter
> apps (Tier 0) and all non-tap SimHID operations (Tier 1 keys/buttons) are
> unaffected.

> **Tier 1.5 AX press (`ax-press`) closes most of the Xcode 26+ tap gap.**
> When the target element advertises the macOS `AXPress` accessibility
> action — which covers nearly every `AXButton`, `AXMenuItem`, `AXCheckBox`,
> and Flutter widget wrapped in `Semantics(button: true, …)` —
> `app_tap_element` / `app_type_element` drive the interaction through the
> existing `ax-bridge` helper instead of synthesising OS-level input. The
> mouse cursor does not move, `Simulator.app` does not have to be
> foregrounded, and the path works on every Xcode version including Xcode
> 26+ where coordinate-based tap/swipe is blocked. Long-press
> (`duration > 0`) and pure coordinate taps (`app_tap({x, y})`) are **not**
> covered by this tier and still need Tier 1 / 2 / 4 depending on the
> platform. See the AX press backend details below for the full selection
> contract and the `OPENSAFARI_DISABLE_AX_PRESS` escape hatch.

### Decision flowchart

```mermaid
flowchart TD
    A([getInputBackend called]) --> F0{Flutter VM reachable?}
    F0 -- Yes --> F0y[return FlutterVMInputBackend]
    F0 -- No --> S0{simctl probe cached?}
    S0 -- No --> S1[probeSimctlInput — xcrun simctl io input tap 0 0]
    S1 --> S2{exit 0?}
    S2 -- Yes --> S3[simctlAvailable = true]
    S2 -- No --> S4[simctlAvailable = false]
    S0 -- Yes --> H0{sim-hid-bridge probed?}
    S3 --> H0
    S4 --> H0
    H0 -- No --> H1[tryCreateSimulatorKitHIDBackend]
    H1 --> H2{bridge resolvable?}
    H2 -- Yes --> Hd{op is tap/swipe on Xcode 26+?}
    H2 -- No --> G{simctlAvailable?}
    H0 -- Yes and cached --> H4{cached backend?}
    H4 -- Yes --> Hd
    H4 -- No --> G
    Hd -- No e.g. key/button --> H3[return SimulatorKitHIDInputBackend]
    Hd -- Yes disabled --> G
    G -- Yes --> G1[return SimctlInputBackend]
    G -- No --> I{webkitClient provided?}
    I -- No --> N
    I -- Yes --> J{isConnected?}
    J -- Yes --> K[return WebKitInputBackend]
    J -- No --> L[tryReconnectWebKit — one attempt]
    L --> M{reconnected?}
    M -- Yes --> K
    M -- No --> N{OPENSAFARI_HEADLESS_ONLY=1?}
    N -- Yes --> O[throw HeadlessInputUnavailableError reason=headless-only]
    N -- No --> N2{isFocusInputAllowed?}
    N2 -- No --> O2[throw HeadlessInputUnavailableError]
    N2 -- Yes --> P[log one-time warning to stderr]
    P --> Q[return AppleScriptInputBackend]
```

The simctl probe result and the sim-hid-bridge lookup result are both
**cached for the process lifetime**. WebKit connection state is checked on
every call because a Safari tab can be closed and reopened between tool
calls. Flutter VM discovery has a per-device 30 s negative cache so native
iOS apps do not pay the discovery cost on every call.

---

## 3. Scenario Matrix

| Scenario | Query (AX) | Input | Headless | Backend Used | Notes |
|----------|-----------|-------|----------|--------------|-------|
| Safari web automation (Xcode ≤ 16) | WebKit Protocol | `simctl` | Yes | `SimctlInputBackend` | Default Tier 2 for Xcode 15 / 16 |
| Safari web automation (Xcode 26+) | WebKit Protocol | `webkit` | Yes | `WebKitInputBackend` | `simctl io input` was removed in Xcode 26 |
| Flutter app (debug / profile build, `flutter run`) | AX bridge (`ax-bridge`) | `flutter-vm` | Yes | `FlutterVMInputBackend` | Requires Dart VM Service + DDS reachable |
| Flutter app (release build or no VM Service, Xcode ≤ 16) | AX bridge | `simhid` | Yes | `SimulatorKitHIDInputBackend` | Falls through Tier 0 → Tier 1 |
| Flutter app (release build or no VM Service, Xcode 26+) | AX bridge | `ax-press` (element-targeted) / `simhid` (keys/buttons) / `applescript` (pure coordinate tap) | Partial | Element-targeted tap/focus via Tier 1.5 AX press; keys via Tier 1; coordinate-only `app_tap({x,y})` still opt-in | Widgets wrapped in `Semantics(button: true, …)` advertise `AXPress` and route headless through Tier 1.5 ([#552](https://github.com/shaun0927/opensafari/issues/552)). Raw coordinate taps still need `OPENSAFARI_ALLOW_FOCUS_INPUT=1` ([#491](https://github.com/shaun0927/opensafari/issues/491)) |
| Native iOS / SwiftUI app (Xcode ≤ 16) | AX bridge | `simhid` or `simctl` | Yes | Tier 1 preferred, Tier 2 fallback | Tier 1 works on every Xcode version |
| Native iOS / SwiftUI app (Xcode 26+, element-targeted) | AX bridge | `ax-press` | Yes | `AccessibilityPressInputBackend` (Tier 1.5) | Default for `app_tap_element` / `app_type_element` when the element advertises `AXPress` |
| Native iOS / SwiftUI app (Xcode 26+, coordinate-only tap/swipe) | AX bridge | `applescript` (opt-in) | Partial | Opt-in Tier 4 via `OPENSAFARI_ALLOW_FOCUS_INPUT=1` | Raw `app_tap({x, y})` still falls through to the focus-stealing backend until Tier 1 tap re-enables ([#491](https://github.com/shaun0927/opensafari/issues/491)) |
| WebView inside native app | AX bridge + WebKit | `webkit` | Yes | `WebKitInputBackend` via `app_webview_connect` | Requires an active WebKit connection |
| GUI-less CI (no display, Xcode 26+, native element-targeted) | AX bridge | `ax-press` | Yes | `AccessibilityPressInputBackend` (Tier 1.5) | Headless element tap/focus via the AX bridge; Simulator.app can stay backgrounded |
| GUI-less CI (no display, Xcode 26+, native coordinate-only tap) | AX bridge | none | No | `HeadlessInputUnavailableError` unless a WebKit client is attached | Blocked until Tier 1 coordinate tap re-enables; use Flutter (Tier 0), WebKit (Tier 3), or re-query the element path to land on Tier 1.5 |
| GUI-less CI (no display, Xcode 26+, native keys/buttons) | AX bridge | `simhid` | Yes | `SimulatorKitHIDInputBackend` | Hardware-button / keyboard injection still headless |
| GUI-less CI (no display, Xcode 26+, Safari) | WebKit Protocol | `webkit` | Yes | `WebKitInputBackend` | Fully headless; recommended CI setup |

---

## 4. Backend Details

### SimctlInputBackend (`kind: 'simctl'`)

Uses `xcrun simctl io <deviceId> input <subcommand>` to inject touch and swipe
events. Works for any app type (Safari, Flutter, native UIKit/SwiftUI). Available
on Xcode versions that ship the `input` subcommand — Apple removed it in Xcode 26.

On every new process the backend executes a probe tap at `(0, 0)` against the
first requested device. If the probe succeeds, `simctlAvailable` is cached `true`
for the process lifetime; otherwise `false`. A cached `SimctlInputBackend` instance
is reused for all subsequent calls.

Status: **Production** (default Tier 1 on Xcode ≤ 16).

### SimulatorKitHIDInputBackend (`kind: 'simhid'`)

Spawns the `sim-hid-bridge` Swift helper as a short-lived child process. The bridge
uses `dlopen` to load `SimulatorKit.framework` and `CoreSimulator.framework` at
runtime (never link-time), resolves a booted `SimDevice` from the UDID, then
injects real `IOHIDEvent`s via the private `SimDeviceLegacyHIDClient` and
`IndigoHIDMessage*` C functions — the same technique used by Facebook's `idb`
(MIT). All private-symbol resolution is confined to the Swift bridge; the
TypeScript side treats the bridge as an opaque child process.

The bridge communicates exclusively via argv (command) and newline-terminated JSON
on stdout. Exit codes are a stable contract:

| Exit | Meaning | TypeScript code |
|------|---------|-----------------|
| 0 | success | n/a |
| 64 | usage / bad args | `BAD_ARGS` |
| 69 | `SimDevice` not booted | `DEVICE_NOT_BOOTED` |
| 78 | `SimulatorKit.framework` (or HID symbols) missing | `SIMULATORKIT_UNAVAILABLE` |

See [`docs/private-apis.md`](private-apis.md) for the full symbol manifest, the
BC-break monitoring strategy, and the policy contract with reviewers.

Status: **Partial** (Tier 1). Activated in
[#490](https://github.com/shaun0927/opensafari/pull/511); tap/swipe routing
subsequently disabled on Xcode 26+ in
[#537](https://github.com/shaun0927/opensafari/pull/537) because
`IndigoHIDMessageForMouseNSEvent`, `IOHIDEventCreateDigitizerFingerEvent` +
`IndigoHIDMessageForHIDArbitrary`, and the pre-registered pointer-service
variant all reproduce the same device-lock bug on iOS 26 (the mouse event
reaches the system gesture recogniser instead of the foreground app, leaving
the screen black). Keyboard (`key`) and hardware-button (`button`) injection
are unaffected and continue to route through this tier — `sim-hid-bridge` is
still probed, cached, and surfaced in `diagnose` output. Re-enabling tap/swipe
is tracked in [#491](https://github.com/shaun0927/opensafari/issues/491).

### AccessibilityPressInputBackend — AX press (`kind: 'ax-press'`)

Tier 1.5 headless tap path. Drives interaction through the existing
`ax-bridge` Swift helper by invoking
`AXUIElementPerformAction(element, kAXPressAction)` against the live AX
element resolved from the tool's element path. No CGEvent synthesis, no
mouse cursor movement, no `Simulator.app` foregrounding — just a second
argv call (`ax-bridge press --path <p> --device <udid>`) to the already-
resolved bridge binary.

Unlike the other tiers this backend is **not** selected by
`getInputBackend()`. It is called directly from `app_tap_element` and
`app_type_element` before they consult the coordinate-based backend
chain. The rationale is that AX press requires the element path — which
only those two composite tools have already resolved — so plumbing it
through the generic `InputBackend.tap(x, y)` signature would force every
backend to grow an element-targeted variant. Keeping the routing
element-scoped also cleanly preserves `app_tap({x, y})`'s contract:
coordinate-only callers continue down the existing Tier 0 → 1 → 2 → 3
→ 4 chain.

Selection contract:

- Enabled for `app_tap_element` / `app_type_element` by default.
- Skipped when `duration > 0` is requested — `AXPress` has no duration
  semantics, so long-press falls through to the coordinate backend.
- Skipped when the resolved element's path is empty (legacy callers that
  pre-date path-based element addressing).
- Skipped when `OPENSAFARI_DISABLE_AX_PRESS=1` is set in the environment.
- If the element does not advertise the `AXPress` action, the bridge
  returns `{ ok: false, code: 'PRESS_NOT_ACTIONABLE', actions: […] }`
  and the tool transparently falls back to coordinate tap.
- If the action fires but `AXUIElementPerformAction` itself returns
  non-success, the bridge returns `{ ok: false, code: 'PRESS_FAILED',
  axErrorCode }` and the tool falls back to coordinate tap (the error is
  logged so the fall-back is observable).
- Bridge-level errors (accessibility permission denied, simulator not
  running) exit non-zero and propagate so the user fixes the setup
  problem instead of silently masking it.

Response shape includes `_meta.backendKind === 'ax-press'`,
`_meta.headless === true`, and `_meta.axActions` listing every action the
element advertised — useful for diagnosing why a press landed where it
did. When `ax-press` cannot prove a post-action effect and the tool falls back
to a coordinate backend, `app_tap_element` now preserves the same verified
interaction contract as `app_tap`: transport-only success is downgraded to
`verified: false` / `effect: "verification_unavailable"` or surfaced as
`TAP_NO_EFFECT` when the UI fingerprint stays unchanged after the tap.

Status: **Production** (Tier 1.5). Shipped in
[#552](https://github.com/shaun0927/opensafari/issues/552). This is the
primary headless tap path on Xcode 26+ for native (non-Flutter)
element-targeted automation.

### WebKitInputBackend (`kind: 'webkit'`)

Injects touch events as JavaScript via WebKit Remote Debugging Protocol (the same
TCP socket used for navigation and screenshots). Operates entirely over the socket —
no window focus, no cursor movement. Limitations:

- Only works when Safari or a WebView is connected via the WebKit protocol.
- Touch events dispatched via JS have `isTrusted: false`, so scroll is supplemented
  with an explicit `window.scrollBy()` call.
- Tap is delegated to `BrowserBackend.click()`, which dispatches `touchstart →
  touchend → click` with `emulateUserGesture: true`.

If the client exists but reports `isConnected() === false`, `getInputBackend()`
makes one reconnect attempt before falling through to Tier 3. This tolerates
transient drops caused by proxy restarts or tab churn.

Status: **Production** (Tier 2; becomes the primary tier on Xcode 26+).

### AppleScriptInputBackend (`kind: 'applescript'`)

Uses `osascript` to activate `Simulator.app` and synthesise CGEvent mouse events
(via inline `swift -e` for taps and drags). This is the only backend that is **not
headless**: it moves the physical mouse cursor, brings the Simulator window to the
foreground, and cannot run in a CI environment without a display.

Because of these side-effects the backend is **default-deny**: `getInputBackend()`
throws `HeadlessInputUnavailableError` instead of silently returning this backend.
It is only instantiated when `OPENSAFARI_ALLOW_FOCUS_INPUT=1` is set, and a
one-time warning is logged to `stderr` at the first tool call.

Status: **Legacy opt-in only**.

### FlutterVMInputBackend (`kind: 'flutter-vm'`)

Injects touch events by sending synthesized `PointerDataPacket` messages,
platform `TextInput.updateEditingState` messages, and `HardwareKeyboard` events
through the Dart VM Service running inside the Flutter engine — no CGEvent
synthesis, no Simulator.app foregrounding, no HID bridge required. Each
operation is dispatched via a library-scoped `evaluate` so the required Dart
symbols (`PlatformDispatcher`, `PointerDataPacket`, `EditableTextState`,
`HardwareKeyboard`, `LogicalKeyboardKey`) are in lexical scope.

The backend requires that the Flutter app was launched via `flutter run` (in
debug or profile mode) so both the Dart VM Service and the Dart Development
Service (DDS) are available — apps launched with `xcrun simctl launch` expose
the socket but lack the compilation service needed for `evaluate`.

A 1.5 s discovery probe bounds the cost of detecting a Flutter VM, and a
per-device 30 s negative cache prevents native iOS apps from paying repeated
probe latency.

Status: **Production** (Tier 0). Shipped in
[#481 / #486](https://github.com/shaun0927/opensafari/pull/486).

---

## 5. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSAFARI_ALLOW_FOCUS_INPUT` | unset (deny) | Set to `1` or `true` to enable `AppleScriptInputBackend`. **Will move the physical mouse cursor and activate `Simulator.app`.** Accepted values: `1`, `true`; anything else is ignored. A one-time warning is logged to `stderr` at the first use. |
| `OPENSAFARI_HEADLESS_ONLY` | unset | Set to `1` or `true` to block the `AppleScriptInputBackend` fallback even when `OPENSAFARI_ALLOW_FOCUS_INPUT` is also set. Recommended for CI — `getInputBackend()` throws `HeadlessInputUnavailableError` with `reason: 'headless-only'` instead of ever returning the focus-stealing backend. Overrides `ALLOW_FOCUS_INPUT` with a warning log when both are set. |
| `OPENSAFARI_ALLOW_SWIFT_INTERPRETER` | unset (deny) | Set to `1` to include the `src/native/sim-hid-bridge.swift` source-tree path in the `tryCreateSimulatorKitHIDBackend()` candidate list. Development-only; skipped in production installs because the repo-relative path escapes `dist/` and executing unsigned Swift source sidesteps future codesigning. |
| `OPENSAFARI_DISABLE_AX_PRESS` | unset | Set to `1` or `true` to disable the Tier 1.5 `AccessibilityPressInputBackend`. `app_tap_element` / `app_type_element` will not try the `ax-press` path and will go straight to the coordinate-based backend chain. Useful for regression-testing the fallback path or working around an AX-press failure mode that has not yet been isolated. |
| `OPENSAFARI_PROXY_PORT` | `9322` | WebKit debug proxy port. Overrides the default port used by `ios_webkit_debug_proxy`. Port resolution order: explicit `port` option → `OPENSAFARI_PROXY_PORT` → `9322`. |

---

## 6. Error Handling

### `HeadlessInputUnavailableError`

Thrown by `getInputBackend()` when no headless input method is available and the
caller has not opted in to the focus-stealing fallback.

```typescript
export class HeadlessInputUnavailableError extends Error {
  readonly name = 'HeadlessInputUnavailableError';
  readonly deviceId: string;          // Simulator UDID
  readonly reason:
    | 'no-simctl'
    | 'no-webkit'
    | 'webkit-disconnected'
    | 'headless-only';
  readonly remediation: readonly string[];
}
```

**Fields:**

- `deviceId` — the Simulator UDID that was passed to `getInputBackend()`.
- `reason` — machine-readable cause:
  - `no-simctl` — `simctl io input` was removed (Xcode 26+) and no higher tier
    matched.
  - `no-webkit` — no `webkitClient` was supplied (caller did not open
    Safari / WebView) after Tier 0 and Tier 1 declined.
  - `webkit-disconnected` — a WebKit client was supplied but failed to reconnect.
  - `headless-only` — `OPENSAFARI_HEADLESS_ONLY=1` blocked the opt-in
    `AppleScriptInputBackend` fallback even though `OPENSAFARI_ALLOW_FOCUS_INPUT`
    was set.
- `remediation` — ordered list of actionable suggestions surfaced in the error
  message and available for structured handling by MCP clients:
  1. For Safari QA: call `set_active_context({ context: 'safari' })` to enable
     `WebKitInputBackend`.
  2. For native apps on Xcode 26+: install `sim-hid-bridge` (ships with
     `npm install opensafari-mcp` — verify with `diagnose`).
  3. As a last resort: set `OPENSAFARI_ALLOW_FOCUS_INPUT=1` (with the documented
     side-effects) and ensure `OPENSAFARI_HEADLESS_ONLY` is not set.

**When it is thrown:**

`getInputBackend()` throws this error when every tier declines:
1. No Flutter VM is reachable on the device (Tier 0 skipped).
2. `sim-hid-bridge` is not present or `SimulatorKit.framework` could not be
   loaded (Tier 1 skipped).
3. `simctlAvailable` is `false` — Xcode 26+ where `simctl io input` was removed
   (Tier 2 skipped).
4. No usable WebKit connection is available (Tier 3 skipped).
5. `OPENSAFARI_ALLOW_FOCUS_INPUT` is unset OR `OPENSAFARI_HEADLESS_ONLY` is set
   (Tier 4 blocked).

**How to handle it:**

```typescript
import { HeadlessInputUnavailableError } from './native-input-backend';

try {
  const backend = await getInputBackend(deviceId, webkitClient);
  await backend.tap(deviceId, x, y);
} catch (err) {
  if (err instanceof HeadlessInputUnavailableError) {
    // err.reason tells you exactly which headless path was unavailable.
    // err.remediation contains human-readable steps for the user.
    console.error('[my-tool] headless input unavailable:', err.remediation.join(' | '));
    // Re-throw or surface to MCP caller — do NOT silently fall back to
    // AppleScript without user consent.
    throw err;
  }
  throw err;
}
```

---

## 7. Private API Policy

The `SimulatorKitHIDInputBackend` path uses two private Apple frameworks:
`SimulatorKit.framework` and `CoreSimulator.framework`. Full details are documented
in [`docs/private-apis.md`](private-apis.md).

Key policies:

- **Runtime-only loading via `dlopen`** — no link-time dependency on private
  frameworks. Missing or broken frameworks surface as a structured
  `InputBackendError` with `code: 'SIMULATORKIT_UNAVAILABLE'` rather than a dyld
  crash.
- **Fallback tiers stay wired** — activating `SimulatorKitHIDInputBackend` will
  not remove `SimctlInputBackend`, `WebKitInputBackend`, or
  `AppleScriptInputBackend`. If the private-framework path breaks (exit code `78`
  or `99`), `getInputBackend()` drops to the next tier automatically.
- **Sentinel CI job** — `tests/ci/sim-hid-sentinel.test.ts` probes framework
  availability and symbol resolution on a daily cron (see
  `.github/workflows/sim-hid-sentinel.yml`). A regression on any previously-passing
  (macOS, Xcode) combination fails loudly while existing tiers continue serving
  users.
- **Update obligation** — any PR that adds or removes a private-symbol dependency
  must update `docs/private-apis.md` in the same change. Reviewers block merges
  that skip this step.

When Apple breaks a private API in a new Xcode release, the recommended response is:

1. The sentinel CI job fires immediately on the affected (macOS, Xcode) combination.
2. The routing layer falls through to `WebKitInputBackend` or the opt-in
   AppleScript path, keeping existing users unblocked.
3. A follow-up PR updates the Swift bridge to adapt to the new symbol layout.

---

## 8. Memory management

See [Memory Budget](memory-budget.md) for the per-cache retention budget and eviction policies.

---

## 9. References

### Related source files

- `src/tools/native-input-backend.ts` — `getInputBackend()`, `InputBackendKind`,
  `HeadlessInputUnavailableError`, `isFocusInputAllowed()`,
  `SimctlInputBackend`, `WebKitInputBackend`, `AppleScriptInputBackend`
- `src/tools/sim-hid-input-backend.ts` — `SimulatorKitHIDInputBackend`,
  `tryCreateSimulatorKitHIDBackend()`, `InputBackendError`
- `src/native/sim-hid-bridge.swift` — Swift bridge that `dlopen`s
  `SimulatorKit.framework` and runs HID injection
- `src/tools/app-tap-element.ts` — composite tap tool that tries Tier 1.5
  AX press before falling through to the coordinate-based backend chain;
  exports `tryPress()` and `buildAXPressResponse()` helpers
- `src/tools/app-type-element.ts` — composite type tool that uses AX press
  for the focus step when available
- `src/native/accessibility-bridge.ts` — `AccessibilityBridge.press()`
  wrapper around the `ax-bridge press` sub-command; `AXPressResponse`
  uniform response shape
- `src/native/ax-bridge.swift` — Swift helper that resolves an
  `AXUIElement` by index path and invokes `AXUIElementPerformAction(_,
  kAXPressAction)`
- `docs/private-apis.md` — private framework contract, exit-code table, BC-break
  monitoring strategy

### Related issues

| Issue | Topic |
|-------|-------|
| [#481](https://github.com/shaun0927/opensafari/issues/481) | Remove `simctl io input` dependency for Xcode 26 compatibility |
| [#483](https://github.com/shaun0927/opensafari/issues/483) | `SimulatorKitHIDInputBackend` — private HID injection via `SimulatorKit.framework` |
| [#484](https://github.com/shaun0927/opensafari/issues/484) | `FlutterVMInputBackend` — headless input via Dart VM Service `PointerDataPacket` |
| [#491](https://github.com/shaun0927/opensafari/issues/491) | SimulatorKitHID integration coverage (blocked on Xcode 26+ tap pipeline) |
| [#496](https://github.com/shaun0927/opensafari/issues/496) | This document |
| [#537](https://github.com/shaun0927/opensafari/pull/537) | Disable SimHID tap/swipe routing on Xcode 26+ while the Apple regression is open |
| [#552](https://github.com/shaun0927/opensafari/issues/552) | `AccessibilityPressInputBackend` (Tier 1.5) — headless element-targeted tap/focus on Xcode 26+ |
