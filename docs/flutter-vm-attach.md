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
