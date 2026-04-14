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
