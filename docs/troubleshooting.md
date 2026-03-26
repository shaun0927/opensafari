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
