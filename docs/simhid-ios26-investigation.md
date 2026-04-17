# SimulatorKitHID iOS 26 investigation — #491

Living document capturing the empirical state of the SimulatorKit HID tap
regression on Xcode 26 / iOS 26.4. The production tap/swipe path in
`sim-hid-bridge` is gated out of Tier-1 routing in
`src/tools/native-input-backend.ts` pending a working alternative.

## Symptom

A `sim-hid-bridge <udid> tap <x> <y>` call on iPhone 16 / iOS 26.4 /
Xcode 26 reports `ok: true` from the HID client, but the simulator
dismisses the foreground app and returns to the home screen instead of
tapping the target coordinates. Hardware buttons and keyboard messages
are unaffected.

Reproduction fixture: `xcrun simctl launch <udid> com.apple.Preferences`,
then `sim-hid-bridge <udid> tap 196 316` (center of the `일반` / General
row on a point-denominated screen).

## Root cause candidates — falsification log

Every candidate below has been exercised end-to-end against a booted
iPhone 16 simulator. Screenshots were captured before and after each
attempt; the "home gesture" outcome means Settings.app was dismissed
to the home screen.

| # | Hypothesis | Probe (bridge subcommand) | Outcome | Evidence |
|---|---|---|---|---|
| 1 | Coord-unit mismatch — pixel input against pixel-denominated screen size (pre-#551) recovers the tap | ad-hoc `/tmp/sim-hid-pixel` binary | ❌ Home gesture | [#551](https://github.com/shaun0927/opensafari/pull/551) |
| 2 | Coord-unit fix alone is sufficient — point input + point-denominated screen size (post-#551) | `sim-hid-bridge tap` (production) | ❌ Home gesture | [#491](https://github.com/shaun0927/opensafari/issues/491), [#537](https://github.com/shaun0927/opensafari/pull/537) |
| 3 | Missing `IndigoHIDMessageToCreatePointerService` registration around mouse events causes the regression | `sim-hid-bridge tap-ps` ([#555](https://github.com/shaun0927/opensafari/pull/555)) | ❌ Home gesture | [#555](https://github.com/shaun0927/opensafari/pull/555) |
| 4 | `IOHIDEventCreateDigitizerEvent` + `IndigoHIDMessageForPointerEventFromHIDEventRef` delivers a touch the simulator accepts | `sim-hid-bridge tap-digitizer` ([#556](https://github.com/shaun0927/opensafari/pull/556)) | ❌ Wrapper returns nil; nothing sent, no tap | [#556](https://github.com/shaun0927/opensafari/pull/556) |

Interpretation:

- Candidate 2 shows that the coord-unit regression from #551 is real
  but not sufficient — the mouse event itself is mis-interpreted by
  iOS 26 regardless of which units we use.
- Candidate 3 shows that service registration is not the missing piece;
  the behaviour of bare mouse events is unchanged after registering a
  pointer service.
- Candidate 4 shows that `IndigoHIDMessageForPointerEventFromHIDEventRef`
  is type-filtered — it rejects digitizer (type 11) events. The
  function name "PointerEvent" likely means it only accepts pointer
  (type 9) events, which are themselves mouse-like and therefore
  unlikely to solve the regression even if we feed them correctly.

## Tools shipped during the investigation

| PR | Subcommand / asset | Purpose |
|---|---|---|
| #543 | *(lint fix)* | Unblocks CI across all investigation branches |
| #547 | `HeadlessInputUnavailableError reason='simhid-gated'` | Surfaces #491 directly in MCP client errors instead of misleading 'no-webkit' |
| #551 | `sim-hid-bridge diag [udid]` | JSON symbol/framework/device probe — verifies the private-API surface without sending any HID events |
| #551 | `getScreenSize()` scale fix | Normalises `mainScreenSize` back to points on Xcode 26 |
| #555 | `sim-hid-bridge tap-ps <x> <y>` | Probe: pointer-service bracketed mouse tap (candidate 3) |
| #556 | `sim-hid-bridge tap-digitizer <x> <y>` | Probe: digitizer IOHIDEvent + pointer-event wrapper (candidate 4) |

## Remaining candidates — ranked by effort × expected yield

Ordering reflects the recommended investigation sequence: start with the
lowest-effort / highest-signal item so that whatever we learn feeds the
next candidate. `Effort` is a T-shirt estimate (S ≤ 1d, M ≤ 3d, L > 3d).
`Yield` captures the expected probability the candidate restores a
working coordinate tap on Xcode 26.

| Rank | Candidate | Effort | Expected yield | Depends on |
|------|-----------|--------|----------------|------------|
| A | **Cross-reference idb's iOS 26 support commits.** idb has been updated for the post-Xcode-26 world; their call shape is the single most reliable data source left. Doc-only update tracking their exact function signatures. | **S** | High (unblocks B/C) | — |
| B | **`IndigoHIDMessageForHIDArbitrary` with a raw HID digitizer report.** Bypasses every typed wrapper and matches idb's post-Xcode-26 production path. Requires constructing a HID digitizer report against the simulator's HID descriptor (undocumented). | **M** | High | A |
| C | **`SimDigitizerInputView.TouchEvent` Swift path.** Instantiate a private NSView (Swift-mangled symbol `_TtC12SimulatorKit21SimDigitizerInputView`), attach it to a detached `SimDisplayView`, and call a non-public `send` method reflectively. | **L** | Medium | B failing |
| D | **Feed the pointer-event wrapper a `kIOHIDEventTypePointer` (type 9) event.** Constructed via `IOHIDEventCreate(..., 9, ...)` if a no-arg factory exists, otherwise requires digging out a pointer-event helper. Pointer events are mouse-like, so likely equivalent to candidates 1/2. | **S** | Low (sanity check) | — |

Meanwhile, **PointerService wiring** ([#590](https://github.com/shaun0927/opensafari/issues/590)) is the interim stop-gap — it shells out to the `sim-hid-bridge tap-ps` probe from candidate 3 and exposes it as an opt-in `PointerServiceInputBackend`, surfacing telemetry so we can decide whether to promote it to the default chain while candidates A–C are investigated.

## Stability commitments

Consumers planning Xcode 26 CI adoption need a clear picture of which
input surfaces are stable, which are opt-in, and which are still
experimental. This table is the authoritative version — the
[README](../README.md#headless-capabilities) and the
[headless-architecture](./headless-architecture.md) routing table
mirror it.

| Surface | Xcode ≤ 16 | Xcode 26+ | Stability | Opt-in flag |
|---------|------------|-----------|-----------|-------------|
| Safari (Web) — `navigate`, `click`, `type`, `screenshot`, … | ✅ stable | ✅ stable | **Stable** | — |
| Flutter app — `app_tap_element`, Dart VM backend | ✅ stable | ✅ stable | **Stable** | — |
| Native app — element-targeted (`app_tap_element`, `app_type_element`, `app_key_input`) | ✅ stable (SimHID Tier 1) | ✅ stable (AX press Tier 1.5) | **Stable** | — |
| Native app — coordinate tap/swipe (`app_tap`, `app_swipe_native`) | ✅ stable (SimHID Tier 1) | ⚠ experimental (PointerService, [#590](https://github.com/shaun0927/opensafari/issues/590)) | **Opt-in experimental** | `OPENSAFARI_ENABLE_POINTERSERVICE=1` |
| Native app — AppleScript/CGEvent fallback | n/a | ⚠ focus-stealing | **Opt-in last resort** | `OPENSAFARI_ALLOW_FOCUS_INPUT=1` |
| WebView in Native — cross-context | ✅ stable | ⚠ partial ([#592](https://github.com/shaun0927/opensafari/issues/592), [#593](https://github.com/shaun0927/opensafari/issues/593)) | **Evolving** | — |

Legend:

- **Stable** — covered by the daily sentinel workflow; regressions will
  file a fresh issue before shipping.
- **Opt-in experimental** — off by default, activated only when the
  listed env flag is set. Telemetry is collected under
  `_meta._telemetry.backend_kind` so we can decide when to promote.
- **Opt-in last resort** — known to steal desktop focus and therefore
  unsuitable for CI. Only kept as an escape hatch for interactive
  workflows.
- **Evolving** — feature area with active follow-up work; expect
  behavioural changes across 0.5.x.

Promotion criteria for the coordinate tap backend: ≥ 99% success over
two weeks of nightly sentinel runs on Xcode 26.0 / 26.1 with zero
AppleScript fallbacks observed. On meeting the bar the
`OPENSAFARI_ENABLE_POINTERSERVICE` flag becomes a no-op kill switch and
the backend moves to Tier 1 in the routing chain (tracked in
[#590 Phase 2](https://github.com/shaun0927/opensafari/issues/590)).

## Why routing stays gated

`src/tools/native-input-backend.ts:871–876` keeps the Tier-1 return
block commented. Until one of the candidates above produces a working
tap, the cached `SimulatorKitHIDInputBackend` is effectively dead
weight for tap/swipe. Hardware buttons and keyboard remain safe to
route — those paths use different IndigoHIDMessage* helpers and are
not affected by the regression.

PR #547 reports this state to MCP clients via the `simhid-gated`
reason, pointing them at #491 and the `OPENSAFARI_ALLOW_FOCUS_INPUT=1`
workaround. The sentinel workflow in `.github/workflows/sim-hid-sentinel.yml`
(#493) continues to run daily, so any additional regression on the
Apple side (e.g. framework path changes) will surface as a separate
signal.

## Next-step checklist for a future investigator

- [ ] Candidate A (effort S): read idb's latest simulator-iOS-26
      commit (git log in the idb repo, filter for the year's
      XCUI/HID changes) and capture the exact signature of the
      replacement function. Update this doc with the findings.
- [ ] Based on the idb findings, pick between candidates B
      (`IndigoHIDMessageForHIDArbitrary`, effort M) and C
      (`SimDigitizerInputView.TouchEvent`, effort L).
- [ ] If candidate B: extend `tap-digitizer` in place — only the
      payload differs.
- [ ] If candidate C: write a new subcommand that spins up a detached
      `SimDigitizerInputView` instance and sends a `TouchEvent`.
- [ ] In parallel, track [#590](https://github.com/shaun0927/opensafari/issues/590)
      Phase 1: PointerService opt-in backend + telemetry so
      `tap-ps` (candidate 3's probe, now shipped as an opt-in
      backend) has real usage data even while candidates A/B/C
      are being explored.
- [ ] Once a candidate produces a verified tap on Settings → General,
      promote it to the default `tap` path and uncomment the Tier-1
      return block in `src/tools/native-input-backend.ts`. The
      `simhid-gated` error reason then becomes unreachable and can be
      retired (or retained as an escape hatch for hosts where the
      helper binary is missing).
- [ ] Re-run the live integration suite
      (`tests/integration/sim-hid-input.live.test.ts`) to flip the
      Settings.app scenarios from pending to green.
