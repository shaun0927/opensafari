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

| # | Candidate | Bridge subcommand / branch | Result |
|---|---|---|---|
| 1 | Pixel-coord input + pixel-denominated screen size (old, pre-#551 behaviour) | ad-hoc `/tmp/sim-hid-pixel` binary | ❌ Home gesture |
| 2 | Point-coord input + point-denominated screen size (post-#551) | `sim-hid-bridge tap` (production) | ❌ Home gesture |
| 3 | IndigoHIDMessageToCreatePointerService bracket around the mouse events | `sim-hid-bridge tap-ps` (#555) | ❌ Home gesture |
| 4 | IOHIDEventCreateDigitizerEvent + IndigoHIDMessageForPointerEventFromHIDEventRef | `sim-hid-bridge tap-digitizer` (#556) | ❌ Wrapper returns nil; nothing sent, no tap |

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

## Remaining candidates (not yet exercised)

1. **Feed the pointer-event wrapper a kIOHIDEventTypePointer (type 9)
   event.** Constructed via `IOHIDEventCreate(..., 9, ...)` if a no-arg
   factory exists, otherwise requires digging out a pointer-event
   helper. Pointer events are mouse-like, so this is likely to end up
   equivalent to candidate 1/2.

2. **`IndigoHIDMessageForHIDArbitrary` with a raw HID report blob.**
   Bypasses every typed wrapper and matches idb's post-Xcode-26
   production path. Requires constructing a HID digitizer report
   against the simulator's HID descriptor (undocumented). The most
   likely-to-succeed candidate, but also the most labour-intensive.

3. **`SimDigitizerInputView.TouchEvent` Swift path.** Requires
   instantiating a private NSView (Swift-mangled symbol
   `_TtC12SimulatorKit21SimDigitizerInputView`), attaching it to a
   detached `SimDisplayView`, and calling a non-public `send` method
   reflectively. Heaviest. Only tractable if candidate 2 also fails.

4. **Cross-reference idb's iOS 26 support commits.** idb itself has
   been updated for the post-Xcode-26 world; their approach — whatever
   it is — is the single most reliable data source we have left. A
   pass-through "idb behaviour comparison" doc update tracking their
   exact call shape would unblock candidate 2 or 3 quickly.

## Why routing stays gated

`src/tools/native-input-backend.ts:854–857` keeps the Tier-1 return
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

- [ ] Read idb's latest simulator-iOS-26 commit (git log in the idb
      repo, filter for the year's XCUI/HID changes) and capture the
      exact signature of the replacement function.
- [ ] Decide between candidates 2 and 3 based on the idb findings.
- [ ] If candidate 2: extend `tap-digitizer` in place — only the
      payload differs.
- [ ] If candidate 3: write a new subcommand that spins up a detached
      `SimDigitizerInputView` instance and sends a `TouchEvent`.
- [ ] Once a candidate produces a verified tap on Settings → General,
      promote it to the default `tap` path and uncomment the Tier-1
      return block in `src/tools/native-input-backend.ts`. The
      `simhid-gated` error reason then becomes unreachable and can be
      retired (or retained as an escape hatch for hosts where the
      helper binary is missing).
- [ ] Re-run the live integration suite
      (`tests/integration/sim-hid-input.live.test.ts`) to flip the
      Settings.app scenarios from pending to green.
