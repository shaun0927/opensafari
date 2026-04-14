# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **`flutter_build_mode`** (#442): New MCP tool that detects the Flutter build mode (debug / profile / release) of the running app and reports which opensafari tools are usable in that mode. Use it when `flutter_connect` fails to distinguish between a release build (VM Service disabled by design) and a configuration issue. Returns a `capabilities` map plus a `fallback_tools` list for release builds.
- **`flutter_toggle_debug_paint`** (#437): New MCP tool that flips Flutter's debug paint overlays (`size`, `baseline`, `repaint_rainbow`) and `time_dilation`, plus an `all_off` reset mode. Backed by `ext.flutter.debugPaint` / `ext.flutter.debugPaintBaselinesEnabled` / `ext.flutter.repaintRainbow` / `ext.flutter.timeDilation`. Useful for diagnosing overflow, padding, and repaint issues via `app_screenshot_native`.
- **`flutter_list_service_extensions`** (#441): Enumerates every VM Service extension registered by the running Flutter app — including third-party ones (`ext.riverpod.*`, `ext.isar.*`, BLoC observers) — with an optional `prefix` filter. Groups results by namespace for easy LLM consumption.
- **`flutter_call_service_extension`** (#441): Generic invoker for any service extension. Auto-injects `isolateId`, enforces an `ext.` prefix, validates `args` is an object, audit-logs every call to stderr. Covers Riverpod / BLoC / Isar / etc. without shipping per-library wrappers (Option B from the issue).

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
