# Troubleshooting

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `opensafari doctor` shows ✗ Xcode | Xcode not installed | Install from App Store |
| No iOS runtimes | Simulator runtime missing | `xcodebuild -downloadPlatform iOS` |
| WebKit connection failed | ios-webkit-debug-proxy not running | `brew install ios-webkit-debug-proxy && ios_webkit_debug_proxy` |
| Simulator won't boot | Device not available | Run `opensafari devices` to see available presets |
| Auth expired | Cookies expired | Re-run `opensafari auth save <site>` |
| Screenshot timeout | Page too heavy | Increase timeout or simplify page |
| Memory warning | Too many simulators | Reduce `--devices` count |
| Port conflict | Another process on 9222 | Use `--webkit-debug-port` flag |
| Rotation failed | Simulator.app not open | Rotation requires GUI; use WebKit viewport fallback |
| Dark mode toggle failed | Device not booted | Boot device first with `device_boot` |
| `app_tree` returns empty tree on Flutter app | Flutter's Semantics tree is lazy — it only populates when an assistive technology connects | `app_tree`, `app_query`, and `app_inspect` auto-call `ensureSemanticsActive()` which toggles `com.apple.Accessibility.AccessibilityEnabled` via `simctl`. If the tree stays empty, restart the app after the first call (the activation flag only affects new accessibility sessions) or add `SemanticsBinding.instance.ensureSemantics()` to `main.dart` for release builds. |
| Flutter widget labels missing from `app_query` | Widget uses `Key('...')` or raw text — neither surfaces to the accessibility tree | Wrap target widgets with `Semantics(label: '…')` or `Semantics(identifier: '…')` (Flutter 3.19+). `Key` values do **not** appear in the AX tree. |
| Safari toolbar elements appear instead of Flutter widgets | Safari is auto-relaunched as a background system app and its AX elements dominate the tree | Terminate Safari with `app_terminate com.apple.mobilesafari`, then call `app_switch_app` to the Flutter bundle. Re-run `app_tree` after the switch. |
| `app_query` returns `total: 0` on a Flutter route that is visibly on screen | One of: stale tree after a route change, missing semantics host on a release build, label wording mismatch, or node is off-screen | Always pass `bundle_id` — it routes activation through the VM-service fallback. Read `_meta.queryRecovery.matchStrategy` and `_meta.queryDiagnostics.visibleSummary` in the response to distinguish the four failure classes (see [docs/flutter-inspector.md § Flutter route verifier workflow](flutter-inspector.md#flutter-route-verifier-workflow-issue-28)). |
| `app_type_element` on a Flutter `TextField` reports `DEVICE_CONTENT_ROOT_EMPTY` or `Element not found` on cold start | `app_type_element` was called without `bundle_id`, so `ensureSemanticsActive` could not reach the Dart VM Service to activate Flutter's lazy Semantics | Pass `bundle_id: "<your.flutter.bundle>"` to `app_type_element`. The parameter was added in the #34/#39 follow-up so the typing path matches the activation model used by `app_tap_element` and `app_query`. |
| `app_type_element` into a Flutter field produces non-Latin transliterated text (e.g. `@ㄷㅌㅁ네`) | Default `auto` backend routes through `simhid` which sends raw HID keycodes — the simulator's active non-Latin IME transliterates them | Pass `backend: "pasteboard"`, which bypasses the software keyboard via `simctl pbcopy` + `Cmd+V` and is Unicode-safe (CJK, emoji). See `tests/fixtures/flutter-qa-app` for a reproducible case. |
| `_meta.queryRecovery.matchStrategy: "relaxed-tree-scan"` — query succeeded but is fragile | The native label/identifier matcher rejected the node; a tree-walk with merged-label / descendant-text matching found it | Acceptable for verifier workflows, but add a `Semantics(identifier: '…')` to the widget so native matching works on subsequent runs without the wider pass. |
