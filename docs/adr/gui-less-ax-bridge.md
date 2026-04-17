# ADR: GUI-less AX Bridge Path

> Status: **Accepted — "no-go" on separate PoC.** The existing
> `src/native/ax-bridge.swift` is already GUI-less: it targets the
> Simulator.app process by PID via `AXUIElementCreateApplication(pid)`, which
> does not require Simulator.app to be the macOS frontmost application.
>
> Tracks: [#573](https://github.com/shaun0927/opensafari/issues/573) ·
> Epic: [#540](https://github.com/shaun0927/opensafari/issues/540) ·
> Predecessor: [#484](https://github.com/shaun0927/opensafari/issues/484)

## 1. Context

Issue #573 was spun out of epic #540 ("No job requires Simulator.app
foreground"). It claimed that while the *input* path had moved to
SimulatorKit HID injection (Tier 1 in
[`docs/headless-architecture.md`](../headless-architecture.md)), the *read*
path through `src/native/ax-bridge.swift` still silently assumed Simulator.app
was the macOS frontmost app. The proposed remediation was a new PoC reader
under `src/native/ax-bridge-gui-less.swift` that uses a private
`SimDevice.io` stream or `SimulatorKit` AX endpoint to read the AX tree
without Simulator.app in the foreground.

## 2. Investigation

We reproduced the "AX read while Simulator.app is not frontmost" scenario
on a booted simulator (`iPhone 17 Pro`, iOS 26.4) with Ghostty forced to
`frontmost=true` via `System Events`.

### 2.1 Direct-CLI run (no MCP host process)

```bash
osascript -e 'tell application "ghostty" to activate'
osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'
# → ghostty

/Users/jh0927/opensafari/dist/ax-bridge dump \
    --device D7D26213-C3E9-4623-BCCB-984CDF5D0793 --max-depth 2
# → exit 0
# → full AX tree, including the iOS content group
#   (Safari BackButton, PageFormatMenuButton, TabBarItemTitle, ReloadButton,
#    MoreMenuButton) at `path: "4"` — exactly what the foreground run returns
```

The bridge returned a complete tree with every expected AX node even though
Ghostty, not Simulator.app, owned the macOS foreground. The single-frame
normalisation (`originX`/`originY` in `buildNode`) and the device-window
walker in `findDeviceContent` both operated correctly.

### 2.2 MCP-host run (Claude Code → Node → ax-bridge)

Running the same command through the `app_tree` MCP tool surfaced
`ax-bridge failed: Command failed: … ax-bridge dump --max-depth 4` from
`AccessibilityBridgeError`. The failure was **not** because Simulator.app
was backgrounded — direct CLI at 2.1 proved that. It was because the AX
client process (the MCP host) lacked the per-bundle
`kAXTrustedCheckOptionPrompt` TCC grant. The same grant is already present
for the terminal binary that ran 2.1.

### 2.3 Why the existing bridge is already GUI-less

`src/native/ax-bridge.swift:402` creates the AX root with:

```swift
let app = AXUIElementCreateApplication(pid)
```

where `pid` is the `Simulator` process PID resolved via
`pgrep -x Simulator`. macOS routes `AXUIElementCopyAttributeValue` calls on
this handle directly to Simulator.app's AX server, regardless of which
process owns `kAXFrontmostAttribute` at that moment. The existing
`press()` code path [documents this property explicitly](
../../src/native/accessibility-bridge.ts#L190-L193):

> Tier 1.5 headless tap path — interaction routed through the macOS
> accessibility API instead of OS-level input synthesis, so the user's
> mouse cursor never moves and `Simulator.app` does not have to be
> foregrounded.

The same guarantee applies to `dump` / `query` / `inspect` because all four
commands resolve through the same `AXUIElementCreateApplication(pid)`
handle.

## 3. Decision

**No-go on a separate `src/native/ax-bridge-gui-less.swift` PoC.** The
existing AX bridge already satisfies the "GUI-less read" goal of epic
#540. Shipping a second bridge built on private `SimDevice.io` / private
`SimulatorKit` AX symbols would:

- Duplicate behaviour that already works under the public
  `ApplicationServices` AX API.
- Enlarge the private-API dependency surface watched by
  [`private-api-sentinel.yml`](../../.github/workflows/private-api-sentinel.yml)
  without a corresponding capability gain.
- Reintroduce risk on macOS / Xcode upgrades that the public AX API has
  already absorbed for us (the bridge has survived the Xcode 15 → 16 → 17 →
  26 transitions unchanged).

## 4. Consequences

### 4.1 Regression test added

Because the GUI-less property of the existing bridge was previously
implicit, a new sentinel probe (probe 7 in
`tests/sentinel/private-api-probe.test.ts`) forces a non-Simulator process
to macOS `frontmost=true` and asserts that `ax-bridge dump` still returns a
valid tree. Any regression that accidentally couples AX reads to
Simulator.app foreground — e.g. a future refactor replacing the PID handle
with `kAXFocusedApplicationAttribute` on the system-wide element — will
fail this probe within 24 hours of the next daily sentinel run.

### 4.2 Files mentioned in #573 that are intentionally **not** created

| File | Disposition |
|---|---|
| `src/native/ax-bridge-gui-less.swift` | **Not created.** Existing `ax-bridge.swift` is the GUI-less path. |
| `src/tools/ax-reader.ts` | **Not created.** AX reads route through `src/native/accessibility-bridge.ts`, which already works without Simulator.app foreground. |

### 4.3 Files **are** created or extended

| File | Change |
|---|---|
| `docs/adr/gui-less-ax-bridge.md` | **This ADR.** |
| `tests/sentinel/private-api-probe.test.ts` | Probe 7 added — AX dump with Simulator.app not frontmost. |
| `.github/workflows/private-api-sentinel.yml` | Header comment updated to list probe 7. |

### 4.4 MCP-host TCC grant — out of scope

The 2.2 failure mode is a per-bundle accessibility permission issue for the
MCP host process, not a bridge design issue. Users running `app_tree` /
`app_query` / `app_inspect` from a new MCP host must grant that host
Accessibility in `System Settings → Privacy & Security → Accessibility`.
This is already documented in
[`docs/troubleshooting.md`](../troubleshooting.md) and will not be
re-addressed here.

## 5. Alternatives considered

### 5.1 Private `SimDevice.io` AX replay target

A private `SimDevice.io` stream with an `AX` replay target was surveyed.
It would move the read surface to a stream that CoreSimulator already
exposes to the host process, avoiding the macOS AX server entirely.
Rejected because:

- The public AX API already works without foreground, so the capability
  gap is zero.
- `SimDevice.io` replay targets are version-gated — CoreSimulator in
  Xcode 26 exposes a different set than Xcode 15/16/17, which would force
  per-version probing and a fallback chain for a property we already own.
- Every private symbol the project loads has to be listed in
  [`docs/private-apis.md`](../private-apis.md) and watched by the private
  API sentinel. Adding symbols with no capability gain is a net
  regression.

### 5.2 `SimulatorKit` private AX endpoint

`SimulatorKit.framework` was surveyed for `AX*` entry points exposed to
host processes for a running `SimDevice`. The symbols it exports today are
HID / input-side (`IndigoHIDMessageForMouseNSEvent`,
`SimHIDClient*`, digitizer / pointer-service helpers), not AX-read side.
The AX serving surface lives inside the guest iOS kernel and is surfaced
to macOS clients through the public `ApplicationServices` AX API that the
current bridge already uses. Rejected because there is no endpoint to
migrate to.

### 5.3 Target `AXUIElementCreateSystemWide()` and filter by PID

Rejected because `AXUIElementCreateSystemWide` routes attribute reads
through `kAXFocusedApplicationAttribute`, which *does* require the target
app to be frontmost. `AXUIElementCreateApplication(pid)` bypasses this
attribute, which is precisely why the existing bridge works.

## 6. Exit criteria disposition

| Criterion from #573 | Status |
|---|---|
| ADR with "go" / "no-go" decision | **Met** — this document records a "no-go" with rationale. |
| If "go": live test proves AX reads succeed with Simulator.app **not** foreground | **N/A** — decision is "no-go". A stronger guarantee (regression test) is supplied instead: sentinel probe 7 asserts the property on every daily run, not only in a one-shot live test. |
| Epic #540 still progresses toward "No job requires Simulator.app foreground" | **Met** — the read side is proven GUI-less; the epic can close its "AX bridge GUI-less path" box. |
