# Coordinate Space Conversion and Flutter Semantics Gap

**Audience**: contributors working on coordinate-based automation (element tapping, coordinate injection) and debugging why taps miss their visible targets on scaled simulators.

**tl;dr**: AX-frame coordinates reported by the accessibility bridge are in macOS-screen-points (relative to the device-content-root), but `sim-hid-bridge` consumes iOS-points (the logical coordinate space of the device under test). On iPhone 17 Pro / iOS 26.4, the scale is ~1.733×. Without conversion, taps land ~73% of the way across the device instead of at the intended target. WU3 (landing in #720) wires the conversion into `app-tap-element`. WU2 (blocked on a Flutter framework limitation) will address a gap where production-build Flutter apps report empty accessibility trees.

## Coordinate Spaces

### macOS-screen-points (AX-frame space)

The accessibility bridge (`ax-bridge.swift`) reports element frames in **macOS-screen-points** — the logical coordinate space of the host Mac's screen. When the Simulator window is scaled (e.g. "Device Window Size" set smaller than native), these coordinates reflect the window's logical coordinates, not the native device resolution.

- Example: iPhone 17 Pro at 50% Simulator window scale → element frame `x: 100, y: 200` in macOS-pt
- Origin: relative to `device-content-root` (the Simulator's on-screen content area)
- Reported on every element's `frame` in `ax-bridge dump` and `ax-bridge query` results
- Size emitted via `deviceContentMacOSPt: { width, height }` on the dump root and query result (PR #695)

### iOS-points (sim-hid / simctl input space)

`sim-hid-bridge` and `simctl` consume **iOS-points** — the logical point space of the device under test, independent of the Simulator window scale.

- Example: iPhone 17 Pro → (402, 874) iOS-points (from `DEVICE_PRESETS`)
- These are the coordinate dimensions you see in Apple documentation (e.g. "iPhone 17 Pro is 402×874 points")
- No scaling: 1 iOS-point = 1 logical device unit, regardless of how large the Simulator window appears on the Mac

### Scale factor (WU3 observation)

When the Simulator window is scaled so that the device-content area is smaller than its native resolution:

```
scale = iOS-pt size / macOS-pt size
```

On iPhone 17 Pro / iOS 26.4 with observed simulator window scale:

```
scale_x ≈ 402 / 232 ≈ 1.733
scale_y ≈ 874 / 504 ≈ 1.734
```

This ratio depends on the Simulator window's "Device Window Size" setting. Different settings produce different scales.

## WU3-prep: deviceContentMacOSPt (PR #695, merged)

PR #695 adds `deviceContentMacOSPt: { width, height }` to the AX dump and query responses so TypeScript callers can compute the scale factor without running additional diagnostics.

**Emitted on**:
- Root node of `ax-bridge dump` response
- Root node of query results from `ax-bridge query`
- Both `AXNodeJSON` and `QueryResultJSON` structures

**Example dump output**:
```json
{
  "role": "AXApplication",
  "label": "MyApp",
  "frame": { "x": 0, "y": 0, "width": 232, "height": 504 },
  "deviceContentMacOSPt": { "width": 232, "height": 504 },
  "children": [...]
}
```

**Source**: `src/native/ax-bridge.swift`, lines 37–46; reports the actual device-content-root frame size from macOS in the AX-frame coordinate system (the `deviceContentMacOSPt` property is defined on line 46).

## WU3-impl: Conversion and Wiring (PR #720)

PR #720 lands `convertMacOSPtToIOSPt` helper and wires it into `app-tap-element` so taps are dispatched at the correct scaled coordinates.

### Helper: `convertMacOSPtToIOSPt`

Located in `src/utils/coordinate-space.ts`:

```typescript
export function convertMacOSPtToIOSPt(
  point: Point2D,
  macOSPtSize: Size2D | undefined | null,
  iosPtSize: Size2D | undefined | null,
): Point2D {
  // Fallback: when either size argument is missing or invalid (0, NaN, Infinity),
  // return the point unchanged. This preserves previous behavior for callers
  // that lack the conversion metadata.
  if (
    !macOSPtSize || !iosPtSize ||
    !Number.isFinite(macOSPtSize.width) ||
    !Number.isFinite(macOSPtSize.height) ||
    macOSPtSize.width === 0 || macOSPtSize.height === 0 ||
    !Number.isFinite(iosPtSize.width) ||
    !Number.isFinite(iosPtSize.height) ||
    iosPtSize.width === 0 || iosPtSize.height === 0
  ) {
    return point;
  }

  return {
    x: point.x * (iosPtSize.width / macOSPtSize.width),
    y: point.y * (iosPtSize.height / macOSPtSize.height),
  };
}
```

**Scale formula**: per-axis scale is `iosPtSize / macOSPtSize`. Applied independently to `x` and `y` to handle non-uniform scaling (rare but possible if the Simulator window is stretched).

### Wiring in app-tap-element

`src/tools/app-tap-element.ts` (as of PR #720) now:

1. Extracts `macOSPtSize` from the query result's `deviceContentMacOSPt` field
2. Calls `getIosPtSizeForDevice(deviceId)` which looks up the device in `DEVICE_PRESETS` by name and returns `{ width: preset.w, height: preset.h }`
3. Passes both sizes to `convertMacOSPtToIOSPt` to scale the AX-frame center coordinates
4. Logs the conversion (including the computed scale factor) to stderr for debugging

**Example log**:
```
[app_tap_element] macOS-pt→iOS-pt conversion applied: macOSPt(100.50, 200.75) → iOSPt(174.17, 347.90) scale=(1.7330, 1.7330)
```

If either size is missing or invalid, the conversion is skipped and the raw AX-frame coordinates are used (fallback to pre-WU3 behavior).

### iOS-point size source

`DEVICE_PRESETS` (in `src/simulator/presets.ts`) stores the canonical iOS-point dimensions for each supported device:

```typescript
'iphone-17-pro': {
  name: 'iPhone 17 Pro',
  w: 402,           // iOS-points
  h: 874,           // iOS-points
  dpr: 3,
  lastVerified: '2026-04-06',
  verifiedXcodeVersion: 'Xcode 26.4',
}
```

Last verified against Xcode 26.4; updates required if new runtime / Xcode versions change device dimensions.

## Limitations

### 1. Conversion gated on known device preset

If the device being tested is not in `DEVICE_PRESETS` (or the device name does not match a preset entry), `getIosPtSizeForDevice` returns `null` and the conversion is silently skipped. Taps then use raw AX-frame coordinates.

**Mitigation**: when testing on a new device, add it to `DEVICE_PRESETS` with the canonical iOS-point dimensions and the Xcode version / verification date.

### 2. Stale `deviceContentMacOSPt` after Simulator window resize

The `deviceContentMacOSPt` size is captured at the time of the AX dump / query call and reflects the actual device-content-root frame at that moment. If the user resizes the Simulator window (Window → Physical Size) between the AX dump and the tap dispatch, the captured size becomes stale and the scale factor is wrong.

**Mitigation**: document that window resizing between element discovery and tap is not recommended. For long-running automation, re-query the element immediately before tapping.

### 3. Flutter Semantics activation gap (WU2 — blocked)

Production-build Flutter apps (release builds, or any Flutter app without VM Service) do not auto-activate the Flutter `Semantics` widget tree. When `SemanticsBinding.ensureSemantics()` is called on a settled release build, the framework does not fire — the tree remains empty. This causes `ax-bridge dump` to report an empty tree (content-root with no children).

`xcrun simctl spawn <deviceId> defaults write com.apple.Accessibility AccessibilityEnabled -bool YES` (the exact command driven by `tryActivateViaSimctl()` in `src/native/semantics-activator.ts`) can write the TCC flag, but does not nudge the Flutter framework. The flag only affects **new** accessibility sessions, so on a release build (no VM Service to hot-reload), the app must be restarted after the flag is written.

**Current status**: workaround documented in troubleshooting; full fix deferred to WU2 pending investigation of `SemanticsBinding` activation on release builds.

**Related**: issue #693 WU2 (design phase), #552 (Flutter Semantics activation research).

## Verification

When debugging a tap that misses its visible target:

1. **Check the conversion log**: if `app-tap-element` prints `[app_tap_element] macOS-pt→iOS-pt conversion applied: ...`, the conversion ran.
2. **Verify device in DEVICE_PRESETS**: run `xcrun simctl list devices` (or `device_list` MCP tool) to see the booted simulator's display name, then check whether that name appears as a `name` field on any entry in `src/simulator/presets.ts`. The match is case-insensitive (per PR #720), so casing differences are not a problem — but missing entries (e.g. a brand-new device) will silently disable the conversion and require adding a preset.
3. **Check Simulator window scale**: if you manually resized the window, re-run the element query immediately before tapping.
4. **For Flutter apps**: ensure the app is built with `--dart-define` or `Semantics(label: '...')` wrapping, and consider adding `SemanticsBinding.instance.ensureSemantics()` to `main()` for release builds.

## References

- **WU3 (Coordinate conversion)**: PR #720, PR #695 (deviceContentMacOSPt emission)
- **WU2 (Flutter Semantics activation)**: issue #693 WU2, #552
- **Coordinate-space implementation**: `src/utils/coordinate-space.ts`, `src/tools/app-tap-element.ts`
- **AX-bridge emission**: `src/native/ax-bridge.swift` (lines 37–46, 91–97)
- **Device presets**: `src/simulator/presets.ts`
- **Related recipe**: [Handling Transient simctl Errors](./transient-simctl-errors.md) (coordinate taps may follow high-velocity input and trigger transient screenshot timeouts)
