# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Documentation

- **Headless architecture doc sync with Tier 0/1 activation** (#492): `docs/headless-architecture.md` no longer claims the SimulatorKit HID path is a PoC — it now documents the 5-tier routing table (Flutter VM → SimulatorKit HID → simctl → WebKit → AppleScript), an updated Mermaid decision flowchart, the Xcode-26-vs-legacy scenario matrix, the full `sim-hid-bridge` exit-code contract, and the `OPENSAFARI_HEADLESS_ONLY` environment variable. `FlutterVMInputBackend` is reclassified from "planned" to "Production (Tier 0)" and `HeadlessInputUnavailableError.reason` now documents the `'headless-only'` variant.
- **README tier table and comparison refresh** (#492): The Input Backend Selection table lists all five tiers (0–4) with the new Tier-0 Flutter and Tier-1 SimulatorKit HID rows, example tool responses include the `_meta.backendKind` / `_meta.headless` envelope, and the Headless Capabilities section now includes a dedicated comparison vs Appium, idb, and XCUITest covering headless native input, Xcode 26+ compatibility, Flutter tap support, MCP integration, and private-API posture.
- **Native iOS app input is now fully headless contract** (#483, #489, #490, #491, #492): The v0.4.6 SimulatorKitHIDInputBackend rollout delivered the contract — native iOS app input is now fully headless via `SimulatorKitHIDInputBackend` activated as Tier 1, replacing the focus-stealing AppleScript fallback as the default for native (non-Flutter) iOS apps. Runtime gate: `getInputBackend()` currently keeps the Tier-1 `return` block commented out pending #491 (SimHID tap/swipe regression that locks the Simulator screen on Xcode 26). The backend class, Swift `sim-hid-bridge` helper, probe cache, and all fallback tiers remain wired; re-enablement is a one-line flip once #491 lands. In the meantime native tap/swipe falls through to Tier 2 (`simctl`, Xcode ≤ 16) or Tier 3 (`WebKit`, Safari/WebView contexts).

## [0.4.7] - 2026-04-15

### Added — FlutterVMInputBackend (Tier 0) ships in production (Epic #484, Issue #481)

- **`FlutterVMInputBackend` — Tier-0 headless Flutter input** (#481, #486): The Dart VM Service-based input backend now ships as the highest-priority routing tier in `getInputBackend()`. When the target device runs a Flutter app in debug or profile mode, pointer events, text input, and key presses are dispatched directly into the Dart isolate via VM Service `evaluate` — completely bypassing OS-level input.
  - `tap(x, y, duration?)` — synthetic `PointerDataPacket` with down/up phases via `PlatformDispatcher.onPointerDataPacket`
  - `swipe(x1, y1 → x2, y2, duration?)` — interpolated `PointerChange.move` events
  - `typeText(text)` — `TextInput.updateEditingState` platform message via primary focus
  - `keypress(hidUsage)` / `sendKey(name)` — `HardwareKeyboard` events with HID → `LogicalKeyboardKey` mapping
  - No CGEvent synthesis, no mouse cursor movement, no Simulator.app focus stealing
  - No `OPENSAFARI_ALLOW_FOCUS_INPUT` opt-in required — Flutter route is always headless
  - Per-device negative cache (30s TTL) prevents repeated discovery probes for non-Flutter devices
  - 1.5s discovery timeout bounds VM Service probe so native iOS apps don't stall input tools
- **Per-operation library scoping for Dart `evaluate`** (#481, #514): The Dart VM Service `evaluate` RPC compiles expressions in the scope of a specific library. Different operations now target the library that exposes their required symbols:
  - tap/swipe → `widgets/binding.dart` (`PlatformDispatcher`, `PointerDataPacket`, `PointerChange`, `PointerDeviceKind`)
  - typeText → `widgets/editable_text.dart` (`FocusManager`, `EditableTextState`, `TextEditingValue`, `SelectionChangedCause`)
  - keypress/sendKey → `services/hardware_keyboard.dart` (`HardwareKeyboard`, `KeyDownEvent`, `KeyUpEvent`, `LogicalKeyboardKey`)
- **DDS requirement documentation** (#481, #515): Documented in `docs/headless-architecture.md` and integration test fixtures that Flutter apps must be launched via `flutter run` (which starts Dart Development Service / DDS and the frontend compiler). Apps launched via `xcrun simctl launch` expose the VM Service socket but lack the compilation service, so `evaluate` calls fail. Integration test fixtures (`tests/integration/flutter-vm-input.live.test.ts`) updated to require a `flutter run`-launched fixture app.

### Test Coverage

- 1510 tests across 103 suites (up from 1488/102 in v0.4.6)
- New: extended `flutter-vm-input-backend.test.ts` coverage for library-scoped evaluate, integration test for tap/swipe/typeText/keypress against a fixture Flutter app
- All tests green on develop with FlutterVMInputBackend coexisting with SimulatorKitHID Tier 1 and the rest of the routing chain

### Notes

This release graduates FlutterVMInputBackend from DRAFT (where it sat in v0.4.5) to production-ready Tier 0. Combined with the SimulatorKitHID Tier 1 work in v0.4.6, OpenSafari now has end-to-end headless input coverage for both Flutter apps and native iOS apps on Xcode 26+ where `simctl io input` was removed.

## [0.4.6] - 2026-04-15

### Added — Headless automation hardening (Epic #484)

- **`SimulatorKitHIDInputBackend` — full HID injection** (#489, #490): The PoC `sim-hid-bridge.swift` now performs real `IOHIDEvent` injection via `SimulatorKit.framework` private API. Activated as **Tier 1** in `getInputBackend()` — native iOS app taps, swipes, and key presses are now headless on Xcode 26+ where `simctl io input` was removed.
  - `tap(x, y, duration?)`, `swipe(x1,y1 → x2,y2, duration?)`, `key(hidUsage)`, `button(home|lock|sound-up|sound-down)` all implemented.
  - Exit code classification: 0 (success), 64 (BAD_ARGS), 69 (DEVICE_NOT_BOOTED), 78 (SIMULATORKIT_UNAVAILABLE), 99 (NOT_IMPLEMENTED).
  - CI sentinel tests (`tests/ci/sim-hid-sentinel.test.ts`) probe SimulatorKit availability daily.
- **`diagnose` MCP tool** (#498): New read-only diagnostic tool that reports backend availability, proxy status, environment variables, and a structured `headless_verdict` JSON. Registered at Tier 1 (always visible). Answers "is this setup truly headless?" in one call.
- **`_meta.backendKind` in input tool responses** (#504): All 10 input tools (`app_tap`, `app_swipe`, `app_scroll_native`, `app_key_input`, `app_double_tap`, `app_type_text`, `app_tap_element`, `app_type_element`, `app_dismiss_keyboard`, `app_alert_handle`) now include `_meta: { backendKind, headless, deviceId }` in their success responses. CI can assert `_meta.headless === true` to verify no focus-stealing backend was used.
- **`OPENSAFARI_HEADLESS_ONLY=1` environment variable** (#499): CI safety net that blocks the AppleScript/CGEvent fallback regardless of `OPENSAFARI_ALLOW_FOCUS_INPUT`. When set, any attempt to fall through to the focus-stealing backend throws `HeadlessInputUnavailableError` with `reason: 'headless-only'` and tailored remediation. Overrides `ALLOW_FOCUS_INPUT` with a warning log when both are set.
- **`docs/headless-architecture.md`** (#496): Comprehensive documentation of the multi-tier input backend routing system — Tier table, Mermaid flowchart of `getInputBackend()`, scenario matrix (Safari/Flutter/Native/WebView), environment variable reference, `HeadlessInputUnavailableError` handling guide, private API policy cross-reference.
- **`docs/ci-recipes.md`** (#497): Copy-paste ready CI workflow recipes for GitHub Actions, Buildkite, and GitLab CI. Covers simulator boot-wait pattern, proxy verification, screenshot artifacts, JUnit reports, and `OPENSAFARI_HEADLESS_ONLY=1` configuration.
- **README "Headless mobile QA automation" tagline** (#500): Project description updated with headless positioning. New Headless Capabilities comparison table (Safari ✅ / Flutter ⚠️ / Native ⚠️ / WebView ⚠️) with links to architecture docs.

### Fixed

- **Proxy socket finder race condition** (#494): `device_boot` consistently failed to auto-start the WebInspectorProxy because `findSocketPath(targetUdid)` was called exactly once with no retry — but `webinspectord_sim` needs several seconds after `simctl boot` to create its Unix socket. Added `waitForSocketPath()` that polls every 500ms for up to 10 seconds. All WebKit-dependent tools (`navigate`, `screenshot`, `app_tap`, etc.) now work reliably after cold boot.
- **`app_tree` / `app_query` ax-bridge not found** (#495): `AccessibilityBridge.resolveBridgePath()` had dead code in candidate 1 and no dev-mode source tree fallback. Rewrote to match the robust 5-candidate pattern from `sim-hid-input-backend.ts` — compiled binary (parent + same dir), Swift source (parent + same dir), plus guarded dev-only fallback via `OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1`. Error message now lists all searched paths.
- **DDS probe for Tier-0 backend** (#519): FlutterVM Tier-0 backend selection now probes for Dart Development Service availability before activation, preventing connection failures on Flutter apps that don't expose DDS.

### Test Coverage

- 1488 tests across 102 suites (up from 1476/100 in v0.4.5)
- New test files: `accessibility-bridge.test.ts` (6 tests), `diagnose.test.ts` (10 tests), `sim-hid-sentinel.test.ts` (5 tests)
- Extended: `native-input-backend.test.ts` (+7 HEADLESS_ONLY tests), `socket-finder.test.ts` (+4 polling tests), `proxy-timing.test.ts` (+2 tests), `app-interaction-tools.test.ts` / `app-scroll-native.test.ts` / `app-dismiss-keyboard.test.ts` / `app-alert-handle.test.ts` (_meta assertions)

## [0.4.5] - 2026-04-15

### Added — Headless input backend infrastructure (Epic #484)

- **`SimulatorKitHIDInputBackend` (PoC)** (#483, #487): New input backend class that bridges to Apple's private `SimulatorKit.framework` via a Swift helper binary (`src/native/sim-hid-bridge.swift`). This is the foundation for headless native-iOS-app automation — HID event injection without moving the user's mouse cursor or stealing Simulator.app focus. Ships as a PoC stub (exit code 99 `NOT_IMPLEMENTED`): the Swift binary validates args, dlopens both `SimulatorKit` and `CoreSimulator` frameworks to prove they are reachable, but defers actual HID injection to a follow-up PR. Routing is intentionally NOT activated — the backend class is exported for manual testing only; `getInputBackend()` continues to select existing tiers. Node wrapper (`src/tools/sim-hid-input-backend.ts`) maps Swift exit codes (64/69/78/99) to structured `InputBackendError` objects. `tryCreateSimulatorKitHIDBackend()` factory probes for the compiled binary or `dist/`-copied source with graceful null return when absent. Source-tree fallback gated behind `OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1` to prevent path traversal when the package is consumed as a dependency.
  - New `docs/private-apis.md` documents: which private frameworks are loaded, where they live, the dlopen rationale, BC-break monitoring strategy (sentinel CI + preserved fallback tiers), license note vs Facebook idb (MIT, independently written), and the maintenance contract.
  - 21 unit tests covering arg construction, exit-code classification, JSON parse failure, factory null path, and swift interpreter fallback.

### Changed

- **`FlutterVMInputBackend` (Tier-0)** (#481, #486): New input backend that dispatches `PointerDataPacket`s, `TextInput.updateEditingState` platform messages, and `HardwareKeyboard` events directly into the Dart isolate via VM Service — no CGEvent, no Simulator.app foregrounding, no `OPENSAFARI_ALLOW_FOCUS_INPUT` opt-in required. Tier-0 routing added to `getInputBackend()`: when a Flutter VM is discoverable, the new backend is selected before all existing tiers. Per-device negative cache (30s TTL) + 1.5s discovery timeout prevent native-app latency regression. Scoped evaluate calls target per-operation Flutter libraries (`mouse_tracker.dart` for pointer dispatch, `editable_text.dart` for text input, `hardware_keyboard.dart` for key events) to ensure all required symbols are in lexical scope.

### Fixed

- **AppleScript input backend: every Tier-3 tap misses by 28pt on Xcode 26** (#482, #485): `AppleScriptInputBackend` hardcoded `TITLE_BAR_HEIGHT = 28` and added it to every iOS→macOS coordinate translation. On Xcode 26 / iOS 26.4 / iPhone 16 the `AccessibilityBridge` already returns frames in macOS-window-relative coordinates, so the +28pt offset sent every CGEvent tap into the empty white space below the actual button (verified live: Login button center at screen y=566, backend computed y=591). Replaced with dynamic measurement via AppleScript that reads the position of `UI element 1 of window 1` (the iOS device screen content area within the macOS window). Per-device cache with explicit `refresh: true` invalidation. Fallback to raw window position with one-time `console.error` per device when the AX query fails.
- **`flutter_widget_at_point` returns wrapper type in `widget_type`** (#436, #479): The tool previously surfaced the raw inspector `_ElementDiagnosticableTreeNode` wrapper in the `widget_type` field because `summariseNode` reads the inspector's own `type` key first. The public payload now prefers `widgetRuntimeType` (e.g. `"ElevatedButton"`) and falls back to `description` before the wrapper `type`, so callers see the Flutter widget name that the checklist promises.
- **`flutter_widget_at_point` `ancestor_chain` always empty against real apps** (#436, #480): `flattenParentChain` only recognised the synthetic `{chain: [...]}` and `{result: {chain: [...]}}` shapes used by the unit tests. The live Flutter 3.11+ response from `ext.flutter.inspector.getParentChain` is `{type: "_extensionType", result: [{node, children}, ...]}` — the `result` key IS the chain array. That third shape is now detected via `Array.isArray(raw.result)`, so the tool returns the real ancestor path instead of an empty list.

## [0.4.4] - 2026-04-15

### Added — Flutter widget-at-point mapping and release-constraint branching

- **`flutter_widget_at_point`** (#436, #471): New MCP tool that maps a physical-pixel coordinate — matching the frame produced by `app_screenshot_native` — to the topmost Flutter widget at that point. The tool reads `devicePixelRatio` live from `FlutterView.platformDispatcher`, converts the physical (x, y) to logical pixels, drives a Dart-side hit-test via `renderView.hitTest(HitTestResult(), position: Offset(…))`, walks `HitTestResult.path` for the topmost `RenderObject` with a `DebugCreator`, selects the owning Element via `WidgetInspectorService.instance.setSelection`, then reads back the selected widget through `getSelectedSummaryWidget`.
  - Returns `{widget_type, description, creation_location, widget_id, ancestor_chain}`. The `ancestor_chain` is pulled from `ext.flutter.inspector.getParentChain` and filtered to user-defined widgets (anything under `package:flutter/`, `package:flutter_localizations/`, or an absolute `flutter/packages/flutter/…` SDK checkout is dropped) so LLM consumers see only the app's own widget hierarchy.
  - Out-of-bounds coordinates (x < 0, x ≥ width, y < 0, y ≥ height) short-circuit to `{widget_type: null, reason: "out-of-bounds"}` without paying a VM Service round-trip. In-bounds misses return `{widget_type: null, reason: "no-hit"}`. Best-effort `ancestor_chain` — a failure in `getParentChain` still yields the topmost widget with `ancestor_chain: []` plus a stderr audit entry.
  - The Dart hit-test expression references `DebugCreator`, `WidgetInspectorService`, `RenderView`, and `HitTestResult` — symbols that live in `package:flutter/src/widgets/widget_inspector.dart` and are NOT re-exported through `flutter/material.dart`. To avoid "Undefined name" failures on user apps that only import material, the evaluate call is now scoped to the inspector library by resolving it via `getIsolate → libraries` and passing its `id` as `targetId`. Throws a dedicated `FlutterVMError('NO_INSPECTOR_LIB')` if the library is not loaded in the isolate.
  - `objectGroup` (the Flutter Inspector lifetime scope) is validated against `/^[A-Za-z0-9_-]+$/` before interpolation into the Dart source literal, blocking Dart injection via a quote-escaped payload. Invalid values raise `FlutterVMError('INVALID_OBJECT_GROUP')`.
- **`FlutterVMClient.selectWidgetAtPoint` / `getParentChain`**: New public VM-client helpers wrapping the hit-test evaluate expression and `ext.flutter.inspector.getParentChain`. Exported so downstream tooling can reuse the coord→widget pipeline without re-implementing the hit-test Dart expression.
- **Flutter version branching for inspector service extensions** (#436, #472): `FlutterVMClient` now captures the Dart VM `version` string at `flutter_connect` time, parses it via the exported `parseDartVersion` helper, and branches `getRootWidgetSummaryTree` calls by Flutter major.
  - Flutter 3.x sessions try `ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews` first and fall back to `getRootWidgetSummaryTree` on VM Service error -32000 (seen on early 3.x releases that have the extension stub but no implementation).
  - Flutter 2.x sessions skip the `WithPreviews` variant entirely — it does not exist on 2.x, and attempting the call was a guaranteed -32601 ("method not found") round-trip on every call.
  - Unknown / unparseable versions preserve the historical try/catch fallback so the client stays forwards-compatible with future Flutter majors.
  - `flutter_connect` responses now include `dartVersion` (structured `{raw, major, minor, patch, channel}`) and `flutterMajor` so downstream tools can gate behaviour per major. New accessors: `FlutterVMClient.getDartVersion()` / `getFlutterMajor()`.
- **`parseDartVersion` helper** (#472): Pure, exported helper that extracts `{major, minor, patch, channel?, raw}` from a Dart VM version string. Null-safe and whitespace-tolerant.

### Added — Live verification harness for #422 / #423

- **Flutter QA fixture app** (#422, #476): Added a dedicated Flutter fixture under `tests/fixtures/flutter-qa-app/`. The fixture exercises the surfaces #422 depends on:
  - `Semantics(label: 'Login')` + `Semantics(identifier: 'login-btn')` wrapping an `ElevatedButton` so `app_query` can be driven by both label and identifier.
  - A `TextField` wrapped in `Semantics(identifier: 'email-field')` so `app_query({identifier: 'email-field'})` and `app_type_element` can be verified against a live editable region.
  - A live `Counter: $n` text that increments on each button tap so downstream suites can assert state changes.
  - `build.sh` helper that runs `flutter pub get`, `flutter build ios --simulator --debug`, and an optional `xcrun simctl install` so reviewers can bring the fixture up with a single command.
  - Bundle id `com.opensafari.fixtures.flutterQaApp` — avoids collision with Flutter's `com.example.*` sample prefix on shared simulators.
- **Live Flutter integration suite** (#423, #473): New opt-in Jest suite at `tests/integration/issue-423-flutter.live.test.ts` that drives a booted simulator against a running Flutter app and proves `app_query` + `app_tap_element` resolve and interact with Flutter Semantics nodes (label, identifier, index, and ambiguous-match cases). Gated behind `jest.config.js` `testPathIgnorePatterns` so the default `npm test` stays headless.
- **Native (non-Flutter) integration suite** (#423, #474): `tests/integration/issue-423-native.live.test.ts` walks `com.apple.Preferences` (Settings → General → About) to prove the shared `AccessibilityBridge` path works identically on UIKit apps — no Flutter-specific branching exists in the bridge, so Settings.app is sufficient to demonstrate parity.
- **Performance harness** (#423, #475): `tests/integration/issue-423-perf.live.test.ts` measures `app_query` / `app_tap_element` round-trip time and asserts an RSS budget (≤ 50 MB over a 100-iteration loop under `--expose-gc`) so regressions surface as perf failures rather than silent slowdowns.
- **Fixture release-constraint integration test** (#422, #478, replaces #477): `tests/integration/flutter-fixture-ax.test.ts` builds the QA fixture above, installs it on a booted simulator, and verifies:
  1. `app_tree` populates even when `useVMServiceFallback: false` — the simctl-path activation must succeed standalone, proving parity with a real Flutter release build (where the Dart VM Service is stripped).
  2. `app_query({identifier: 'login-btn'})` and `app_query({identifier: 'email-field'})` return the expected `Semantics(identifier:)` nodes with correct role (`AXButton` / `AXGenericElement`), visibility, and enabled flags.
  - Honours `FLUTTER_BIN` env override with a `flutter`-on-PATH fallback so the suite runs uniformly on Apple Silicon brew, Intel brew, asdf, and nix installs.
  - `console.error` SKIP log suppressed when `process.env.CI` is set so the always-skipped-in-CI suite stops spamming shared CI output.

### Changed

- `FlutterVMClient.getDartVersion()` now returns the structured `DartVersion` type (exported from `src/flutter/flutter-types.ts`) — additive to the prior `null | undefined` shape for callers that were only checking truthiness. `getFlutterMajor()` normalises all absent-version states to `null` for consistent consumer code.

### Security

- **Dart injection hardening for `flutter_widget_at_point`** (#471): `objectGroup` is now rejected before interpolation when it contains any character outside `[A-Za-z0-9_-]`. The prior implementation concatenated the raw caller-provided string into a Dart source literal via `'${objectGroup}'`, which a malicious caller could have used to break out of the quoted context and execute arbitrary Dart on the target device. Local MCP is a trusted-caller context, but defence-in-depth is cheap.

### Fixed

- Removed stale `flutter create` boilerplate `widget_test.dart` from the QA fixture (#476 review P1). The stub asserted `find.byIcon(Icons.add)` and a counter starting at `"0"`, but the fixture's `main.dart` was rewritten to render Semantics + TextField + `Counter: $n`; `flutter test` inside the fixture would have failed immediately, undermining the "fixture is stable" contract.
- Dropped the Apple-Silicon-only hardcoded `/opt/homebrew/bin/flutter` probe from the fixture integration test (#477/#478 review P1) in favour of a `FLUTTER_BIN` env override with a `flutter`-on-PATH fallback. The prior probe always threw on Intel Macs, nix, and asdf before the fallback ran.
- Tightened the `selectWidgetAtPoint` hit-result parsing: dropped the tautological `kind === 'Bool' && valueAsString === 'true'` disjunct that was subsumed by the primary `valueAsString === 'true'` check.

### Tests

- 1395+ tests / 97+ suites pass on `npm test` (the default headless run). New gated integration suites under `tests/integration/**` are excluded from the default run and exercised manually by reviewers with a booted simulator.
- 25 new unit tests in `tests/unit/flutter-widget-at-point.test.ts` cover: DPR=2/3 conversion, out-of-bounds short-circuit, no-hit path, successful hit with ancestor-chain filtering, not-connected errors, non-finite coordinate rejection, `objectGroup` sanitization, missing `widget_inspector` library handling, and best-effort `getParentChain` failure.
- 11 new unit tests in `tests/unit/flutter-version-branching.test.ts` cover: Dart version parsing (happy / whitespace / invalid / missing channel), 3.x happy path / 3.x WithPreviews fallback / 2.x direct call / unknown-version try/catch fallback, and `getDartVersion` / `getFlutterMajor` pre- and post-connect state.

### Release metadata

- npm: [`opensafari-mcp@0.4.4`](https://www.npmjs.com/package/opensafari-mcp/v/0.4.4)
- git tag: `v0.4.4`
- compare: [`v0.4.3…v0.4.4`](https://github.com/shaun0927/opensafari/compare/v0.4.3...v0.4.4)
- merged PRs: #471, #472, #473, #474, #475, #476, #478

## [0.4.0] - 2026-04-14

### Added — Flutter Advanced Debugging & Profiling

- **`flutter_build_mode`** (#442): New MCP tool that detects the Flutter build mode (debug / profile / release) of the running app and reports which opensafari tools are usable in that mode. Use it when `flutter_connect` fails to distinguish between a release build (VM Service disabled by design) and a configuration issue. Returns a `capabilities` map plus a `fallback_tools` list for release builds.
- **`flutter_toggle_debug_paint`** (#437): New MCP tool that flips Flutter's debug paint overlays (`size`, `baseline`, `repaint_rainbow`) and `time_dilation`, plus an `all_off` reset mode. Backed by `ext.flutter.debugPaint` / `ext.flutter.debugPaintBaselinesEnabled` / `ext.flutter.repaintRainbow` / `ext.flutter.timeDilation`. Useful for diagnosing overflow, padding, and repaint issues via `app_screenshot_native`.
- **`flutter_list_service_extensions`** (#441): Enumerates every VM Service extension registered by the running Flutter app — including third-party ones (`ext.riverpod.*`, `ext.isar.*`, BLoC observers) — with an optional `prefix` filter. Groups results by namespace for easy LLM consumption.
- **`flutter_call_service_extension`** (#441): Generic invoker for any service extension. Auto-injects `isolateId`, enforces an `ext.` prefix, validates `args` is an object, audit-logs every call to stderr. Covers Riverpod / BLoC / Isar / etc. without shipping per-library wrappers (Option B from the issue).
- **`flutter_evaluate`** (#434): New MCP tool that evaluates arbitrary Dart expressions against a running Flutter app's main isolate via the VM Service `evaluate` / `evaluateInFrame` RPCs. Default scope is the main isolate's root library; `scope="frame"` with `frame_index` targets a paused stack frame (future-compatible with breakpoint support in #435). Results are normalised into a compact shape — primitives return `valueAsString`, composites expose 1-depth `fields`. Debug/profile builds only.
- **`FlutterVMClient.evaluate` / `evaluateInFrame`**: New public VM-client helpers that auto-resolve the root library target and surface typed errors (`NO_ISOLATE`, `NO_ROOT_LIB`).
- **`flutter_root_widget`** (#436): Dumps the running Flutter app's widget summary tree via `ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews`. Each node includes `type`, `description`, and `creationLocation` (file:line:column) so callers can jump straight to the source.
- **`flutter_inspect_selection`** (#436): Returns the currently selected widget via `ext.flutter.inspector.getSelectedSummaryWidget`, with an optional `show` flag that toggles the in-app inspector overlay (`ext.flutter.inspector.show`) to arm coordinate-based selection. Empty selection returns `status: "empty"` with a usage hint.
- **`FlutterVMClient.getRootWidgetSummaryTree` / `getSelectedWidget` / `setInspectorShow`**: New VM-client helpers wrapping the Flutter Inspector service extensions.
- **`flutter_cpu_profile`** (#439): Samples the Dart VM CPU profiler via `getCpuSamples` for a configurable window (max 120s) and returns a top-N list of `{function, self_us, total_us, samples}`. Pure `aggregateCpuSamples` helper exported for testing.
- **`flutter_timeline_capture`** (#439): Enables VM timeline streams (default `["Dart", "GC", "Embedder"]`), waits a window, fetches `getVMTimeline`, and writes Chrome Trace Event JSON loadable in `chrome://tracing` or Perfetto.
- **`flutter_track_rebuilds`** (#438): Drives the Flutter dirty-widget rebuild tracker. `start` / `report` / `stop` actions, optional `duration_ms` auto-stop, capped at 10,000 events per tracker.
- **`flutter_allocation_profile`** (#440): Per-class allocation profile via `getAllocationProfile`. Supports `gc_before` and `diff_against_previous` for the standard leak-hunt pattern (baseline → action → diff).
- **`flutter_heap_snapshot`** (#440): Full Dart heap snapshot via `requestHeapSnapshot`, written as binary importable by Flutter DevTools' Memory tab. Configurable `timeout_ms` (default 60s, max 10min).
- **Breakpoint / step debugging** (#435): Five new MCP tools that drive the Dart VM Service debugger end-to-end.
  - `flutter_set_breakpoint({ script_uri, line, column? })` — wraps `addBreakpointWithScriptUri`
  - `flutter_remove_breakpoint({ breakpoint_id })` — wraps `removeBreakpoint`
  - `flutter_resume({ mode: "continue" | "step_into" | "step_over" | "step_out" })` — wraps `resume` with the matching `step` token
  - `flutter_get_stack({ limit? })` — wraps `getStack` with a compact per-frame summary (`function`, `location: {script_uri, line}`, `vars`)
  - `flutter_wait_for_pause({ timeout_ms?, poll_interval_ms? })` — polls for pause state, mirroring `app_wait_for`; returns `{timeout: true}` on timeout
- Per-device `BreakpointManager` lazily subscribes to the `Debug` stream and tracks pause state + active breakpoints. Pure helpers `resumeModeToStep`, `summariseFrame`, `_resetBreakpointManagers` exported for testability.

### Fixed

- **Breakpoint manager** (#435): Cleans listeners on disconnect and detects VM reconnect to avoid stale state.
- **Memory profiler** (#440): LRU cap on `previousSnapshots` prevents unbounded memory growth; `forgetAllocationHistory` exposed.
- **Track rebuilds** (#438): Rolls back listener registration if `track_rebuilds start` fails mid-setup.
- **Track rebuilds event name** (#438): Fixed filter to match `Flutter.RebuiltWidgets` (past tense, the actual event name Flutter emits from `widget_inspector.dart:2538`) instead of `Flutter.RebuildWidgets`. Without this fix, no rebuild events were captured in live apps.
- **CPU profiler** (#439): Resets timeline flags on capture failure to avoid leaving streams enabled.
- **Widget inspector** (#436): Clamps `max_depth` and adds cycle guard to `summariseNode`.
- **Evaluate** (#434): Security docstring, audit log, Null handling, whitespace guard.
- **Service extensions** (#441): Caller cannot silently retarget `isolateId`.
- **Debug paint** (#437): `all_off` tolerates partial failure and caps dilation.
- **Build mode** (#442): Reports `'unknown'` when URL discovered without connect.
- **Lint** (#452): Fixed 12 pre-existing lint errors blocking CI on feature branches.

## [0.3.1] - 2026-04-13

### Security / Behavior change

- **Default-deny AppleScript/CGEvent input backend** (#405): The focus-stealing `AppleScriptInputBackend` is no longer instantiated automatically on Xcode 26+. When no headless input method is available, `getInputBackend()` throws `HeadlessInputUnavailableError` with actionable remediation guidance instead of silently moving the physical mouse cursor and activating `Simulator.app`.
  - To re-enable the legacy fallback, set `OPENSAFARI_ALLOW_FOCUS_INPUT=1` in the environment.
  - All affected tools (`app_tap`, `app_swipe_native`, `app_scroll_native`, `app_double_tap`, `app_type_text`, `app_key_input`) surface the error as a structured MCP tool error.
  - Tool results now include a `backend` field (`simctl` / `webkit` / `applescript`) for audit/observability.

### Added

- **WebKit reconnect retry**: When a WebKit client exists but reports disconnected, `getInputBackend()` attempts a one-shot reconnect before falling through, reducing false positives from transient proxy/tab drops.
- **`HeadlessInputUnavailableError`** class with structured fields (`deviceId`, `reason`, `remediation[]`) exported from the public barrel for typed error handling by MCP clients.

## [0.3.0] - 2026-04-13

### Added

- **Flutter app QA automation**: 12 new MCP tools for automating and testing Flutter apps on iOS Simulator, including Dart VM Service bridge, widget tree inspection, hot reload, and network traffic capture.
- **Semantic element targeting**: `app_tap_element`, `app_wait_for`, `app_assert_element` — interact with UI elements by label/identifier instead of fragile x,y coordinates.
- **Flutter QA detectors**: Automated checks for tap target sizes (`qa_flutter_touch_targets`), accessibility coverage (`qa_flutter_semantics`), and dark mode rendering (`qa_flutter_dark_mode`).
- **Flutter network monitoring**: HTTP proxy-based traffic capture for any app including Flutter.

## [0.2.1] - 2026-04-05

### Added

- **NativeInputBackend abstraction** (`native-input-backend.ts`): Input backend layer with automatic Xcode version detection. Provides `InputBackend` interface (tap, swipe, typeText, keypress, sendKey) with two implementations:
  - `SimctlInputBackend`: Uses `xcrun simctl io input` commands (Xcode 15–16)
  - `AppleScriptInputBackend`: Uses `osascript` + Swift CGEvent for input (Xcode 26+)
- **Auto-detection**: Probes `simctl io input` on first use and automatically falls back to AppleScript/CGEvent when unavailable. Result is cached for process lifetime.
- **HID-to-AppleScript key mapping**: Translates USB HID key codes to macOS virtual key codes for the AppleScript backend, supporting Return, Escape, Tab, Space, arrow keys, Backspace, and Home.
- **Native app tool surface docs** (`docs/native-app-tool-surface.md`): Complete reference for all 31+ native app automation tools.
- **CI integration examples** (`docs/ci-integration.md`): Expanded with native screenshot, log export, assertion, and hybrid context switching workflow examples.

### Fixed

- **Xcode 26 compatibility**: All 8 native interaction tools (`app_tap`, `app_double_tap`, `app_type_text`, `app_swipe_native`, `app_key_input`, `app_scroll_native`, `app_alert_handle`, `app_dismiss_keyboard`) now work on Xcode 26.4 where `simctl io input` subcommand was removed.
- **app_alert_handle simplified**: Replaced dual simctl/AppleScript fallback code with unified `InputBackend.sendKey()` delegation, reducing code by 60 lines.
- **app_dismiss_keyboard unified**: Migrated from direct simctl calls to InputBackend, ensuring consistent behavior across Xcode versions.

### Changed

- All native interaction tools now use `getInputBackend()` instead of direct `SimctlExecutor.exec()` calls. This is a transparent change — tools behave identically on Xcode versions that support `simctl io input`.

## [0.2.0] - 2026-04-05

### Added

- **Native app screenshot capture** (`app_screenshot_native`): Full simulator screen capture with deterministic status bar masking for diffable CI screenshots. Supports PNG/JPEG output with base64 encoding.
- **Device log export** (`app_logs`): Structured JSON log export from simulator using NSPredicate filtering. Supports filtering by bundle ID, log level (default/info/debug/error/fault), time range, and text search.
- **Native assertions** (`app_assert`): CI-friendly structured assertion tool with 5 assertion types (`app_running`, `element_exists`, `element_visible`, `screen_contains_text`, `text_matches`). Returns JSON results with pass/fail, duration, and timestamp for pipeline integration.
- **Hybrid context switching** (`app_webview_connect`, `set_active_context`): Discover WebView targets inside running native apps and switch automation context between Safari and embedded WebViews. Target classification distinguishes Safari pages from WebView content by URL scheme.
- **CI documentation for native tools**: Expanded `docs/ci-integration.md` with examples for native screenshots, log export, structured assertions, hybrid context switching, and artifact upload workflows.

### Scope & Limitations

- Native assertion `element_exists` / `element_visible` require Xcode 14+ with `simctl io enumerate` support.
- Hybrid context switching relies on ios-webkit-debug-proxy target discovery; apps must have Web Inspector enabled for WebView targets to appear.
- `app_screenshot_native` captures the full simulator display, not individual app windows.
- Screen recording (`app_record_video`) is available but marked as experimental.

## [0.1.5] - 2026-03-31

### Added

- **iPhone SE device presets**: Added `iphone-se-1`, `iphone-se-2`, and `iphone-se-3` presets covering all three iPhone SE generations (320x568, 375x667 @2x/3x) for small-screen QA testing.
- **HTML report screenshots**: QA audit HTML reports now embed original and annotated page screenshots directly in the report via base64 `<img>` tags, providing visual context alongside detector results.
- **Device comparison HTML layout**: Cross-viewport comparison tool now generates a structured HTML report with per-device cards showing device name, viewport dimensions, and screenshot — replacing the previous inline HTML string construction.
- **Zombie cleanup scoping & configuration**: Zombie device cleanup now only targets devices registered by OpenSafari processes (via a PID-based device registry), preventing accidental shutdown of unrelated simulators. New environment variables (`OPENSAFARI_ZOMBIE_CLEANUP_ENABLED`, `OPENSAFARI_ZOMBIE_CLEANUP_INTERVAL_MS`, `OPENSAFARI_ZOMBIE_CLEANUP_MAX_AGE_MS`) allow fine-grained control over cleanup behavior.
- **CI/CD integration guide**: New `docs/ci-integration.md` with detailed instructions for running `qa_full_audit` in GitHub Actions, GitLab CI, and Jenkins pipelines, including artifact collection and threshold gating.
- **API reference documentation**: Expanded `docs/api-reference.md` with `qa_full_audit` format specification.
- **E2E validation fixtures**: Added `buggy-page.html`, `clean-page.html`, and `validation-report.json` test fixtures for QA detector end-to-end validation.
- **New test suites**: Added comprehensive tests for zombie cleanup cross-session behavior (#263), proxy initialization timing (#264), socket finder verification (#265), HTML report generation (#211), and E2E gesture verification.

### Fixed

- **WebKit error capture protocol**: Replaced Chrome-specific `Runtime.exceptionThrown` with WebKit-native `Console.messageAdded` for JavaScript error capture, fixing `onError` handler that was silently failing on real Safari (#200).
- **TOCTOU race in zombie cleanup**: Eliminated time-of-check-to-time-of-use race condition by introducing a single-lock registry partition (`getOrphanedAndLiveDeviceIds`) that atomically reads both orphaned and live device sets in one operation.
- **Accessibility detector regex**: Reverted incorrect double-escaping in accessibility detector template literal regex and removed unused imports (#254).
- **Cross-viewport breakpoint logic**: Removed redundant breakpoint condition in `CrossViewportCapture` that could cause duplicate captures at boundary widths.
- **Lint and import cleanup**: Fixed unused `AnnotationResult` import in `audit.ts`, duplicate variable declaration in auth integration test, unused imports in E2E gesture test, and various lint errors in zombie cleanup tests.
- **Test infrastructure**: Corrected test import paths and added `NaN` guard for environment variable parsing to prevent CI test breakage.

### Changed

- **`assert_all_devices` tool simplified**: Removed the `includeScreenshot` parameter and per-device screenshot embedding from `assert_all_devices` results, reducing response payload size and eliminating the unused `screenshot` destructuring that caused the CI lint failure.
- **Cross-viewport compare refactored**: Moved HTML generation from inline string construction in `cross-viewport-compare.ts` to a dedicated `generateComparisonHtml()` function in `report-html.ts`, improving maintainability and enabling reuse.
- **E2E gesture test relocated**: Moved E2E gesture verification test from unit to integration directory to reflect its actual test scope.

## [0.1.2] - 2026-03-28

### Added
- Initial release of OpenSafari MCP server
- 41+ MCP tools for iOS Safari automation
- SimulatorManager: boot, shutdown, screenshot, appearance, rotation
- WebKitClient: navigate, evaluate, screenshot via WebKit Remote Debugging Protocol
- 13 iOS QA detectors: auto-zoom, touch targets, safe area, keyboard overlap, etc.
- qa_full_audit with scoring and regression detection
- Multi-simulator parallel testing with batch operations
- Cross-viewport visual comparison with Claude Vision format
- Login persistence via cookie export/import
- CLI: serve, auth, doctor, devices commands
- Self-healing: crash recovery, resource monitoring, graceful shutdown
