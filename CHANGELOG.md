# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Flutter version branching for inspector service extensions** (#436): `FlutterVMClient` now captures the Dart VM `version` string at `flutter_connect` time, parses it via the exported `parseDartVersion` helper, and branches `getRootWidgetSummaryTree` by Flutter major. Flutter 3.x sessions try `ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews` first (falling back to `getRootWidgetSummaryTree` on VM Service error -32000), Flutter 2.x sessions skip the `WithPreviews` variant entirely, and unknown versions preserve the historical try/catch fallback. `flutter_connect` responses now include `dartVersion` and `flutterMajor` so downstream tools can gate behaviour per major. New accessors: `FlutterVMClient.getDartVersion()` / `getFlutterMajor()`.

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
