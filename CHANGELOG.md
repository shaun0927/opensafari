# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3] - 2026-03-31

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
