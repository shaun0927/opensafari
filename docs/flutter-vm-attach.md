# Deterministic Flutter VM attach for mobile QA

OpenSafari does not own `flutter run`. Launch the Flutter app externally, then use
`flutter_connect` to attach to the VM Service for debug/profile inspection.

Recommended debug/profile launch patterns:

```sh
flutter run --debug --host-vmservice-port=50642
flutter run --profile --host-vmservice-port=50642
```

Then attach with one of:

```json
{ "vm_service_url": "http://127.0.0.1:50642/<auth-code>/" }
{ "vm_service_port": 50642, "vm_service_auth_code": "<auth-code>" }
```

Attach priority is explicit URL, environment URL, environment WS URL, cached URL,
fixed-port input, then simulator log scan. Failure payloads include typed attempts
and troubleshooting suggestions for stale cache, closed fixed ports, invalid URL
shape, auth-code mismatch, and release-build limitations.

Release builds disable VM Service. Treat VM unavailable as data and fall back to
AX/native semantic tools unless the scenario explicitly requires Flutter VM.

## Success response fields

A successful `flutter_connect` returns, in addition to `status`, `vmServiceUrl`,
`wsUrl`, `deviceId`, `attachDiagnostics`, `vm`, `mainIsolateId`, `dartVersion`,
and `flutterMajor`:

| Field | Meaning |
|-------|---------|
| `buildMode` | Detected build mode: `debug`, `profile`, or `unknown`. (A successful connect is never `release` — release disables the VM Service.) |
| `vmServiceAvailable` | Always `true` on a successful connect; present so the contract is uniform with the failure path. |
| `capabilities` | Per-capability booleans (`hot_reload`, `logs`, `widget_tree`, `evaluate`, `breakpoints`, `cpu_profile`, `heap_snapshot`, `network_proxy`, `ui_automation`, `screenshot`). |
| `evaluateProbed` | Whether `capabilities.evaluate` was confirmed by a live probe (`true`) or inferred (`false`, for `debug` where JIT always evaluates). |

`capabilities.evaluate` is the load-bearing signal for Tier-0 tooling. It is
**probe-backed**, not inferred from `buildMode`: a no-compiler AOT attach (e.g.
`simctl launch` without `flutter run`) is classified `profile` yet rejects
`evaluate` with code 113, so the connect issues one `evaluate('1')` probe and
reports the empirical result. An MCP client should branch on
`capabilities.evaluate` rather than `buildMode` when deciding whether to call
`flutter_evaluate`, widget hit-testing, or synthetic pointer input.
