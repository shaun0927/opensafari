# Private Apple Frameworks Used by OpenSafari

> Status: **Production** — `SimulatorKitHIDInputBackend` ships as Tier 1 of
> `getInputBackend()` (activated in #490). A daily
> [`sim-hid-sentinel` CI job](../.github/workflows/sim-hid-sentinel.yml) guards
> against Apple BC breaks. This document is the stability contract: every
> private symbol the project touches is listed here, together with the
> fallback plan if Apple changes or removes it.

OpenSafari keeps the set of private-framework dependencies small and
auditable. Every private symbol we touch is listed here together with:

1. Where the framework physically lives on disk.
2. How we load it (always `dlopen`, never link-time).
3. The behavioural contract with the TypeScript side.
4. The monitoring / fallback strategy for Apple BC breaks.

If you add a new private-framework call, you **must** update this file in
the same PR. Reviewers will block merges that skip this step.

## Deployment scope

> **TL;DR — host-side simulator automation only. Do not bundle into a shipping iOS app.**

OpenSafari loads `SimulatorKit.framework` and `CoreSimulator.framework` via
`dlopen` and uses Apple-private IOKit / Accessibility entry points. These
frameworks are part of the **macOS developer toolchain** (they ship inside
`/Library/Developer/PrivateFrameworks/` and `Xcode.app`), not the iOS SDK,
and they are intended for tooling that drives the iOS Simulator from a
developer Mac.

### ✅ Allowed

- Running OpenSafari on a developer Mac as an MCP server / CLI.
- Running OpenSafari on macOS CI runners (GitHub Actions `macos-*`,
  Buildkite Mac agents, internal Mac mini farms) for headless QA against
  the iOS Simulator.
- Bundling OpenSafari with internal developer tooling distributed to
  engineers (it never leaves macOS).

### ❌ Not allowed

- **Bundling `sim-hid-bridge`, `ax-bridge`, the SimulatorKit `dlopen`
  helper, or any other private-API helper inside an iOS `.ipa` submitted
  to the App Store, TestFlight, Ad Hoc, or Enterprise (in-house)
  distribution.** Private frameworks and undocumented APIs trigger App
  Store Review Guideline 2.5.1 / 2.5.2 rejections, and Enterprise
  Distribution programs prohibit shipping software that uses
  non-public APIs.
- Shipping derivative works that load `SimulatorKit.framework`,
  `CoreSimulator.framework`, or any `Indigo*` / `IOHIDEvent*` symbol
  inside an iOS device build (the symbols don't exist on-device anyway,
  but stripping them out of a fork before redistribution is the
  consumer's responsibility).
- Re-targeting the helpers to drive a physical iOS device. The
  SimulatorKit HID path operates on `SimDevice` instances managed by
  CoreSimulator; it has no on-device counterpart and any attempt to
  port it would require additional, separately-prohibited private APIs.

### Rationale

- **Apple App Review** — Guideline 2.5.1 requires apps to use only
  public APIs; 2.5.2 requires self-contained executable code. Bundling
  `dlopen("…/SimulatorKit.framework/SimulatorKit")` inside an iOS app
  fails both even before the framework's absence on iOS becomes the
  immediate runtime crash.
- **Framework provenance** — `SimulatorKit.framework` and
  `CoreSimulator.framework` live under
  `/Library/Developer/PrivateFrameworks/` (Mac developer tools), not in
  any iOS SDK. They have no code-signing entitlement that would let
  them ship inside an `.ipa`.
- **Same posture as `idb`** — Facebook's `idb` (which uses the same
  SimulatorKit HID surface) is a host-side daemon for the same reason;
  it is not shipped inside iOS apps either.

### License interaction

The MIT license on this repository covers OpenSafari's own source. It
does **not** sublicense Apple's frameworks. Any use of
`SimulatorKit.framework`, `CoreSimulator.framework`, or other Apple
private APIs remains subject to the Xcode and macOS license agreements
you accepted when installing them. See [`../LICENSE`](../LICENSE) for
the OpenSafari grant; consult Apple's developer agreements for the
permissible scope of the loaded frameworks themselves.

## Loaded frameworks

| Framework | Path | Why |
|---|---|---|
| `SimulatorKit.framework` | `/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit` | HID event injection into a booted simulator |
| `CoreSimulator.framework` | `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator` | Resolve a booted `SimDevice` from a UDID |

Both frameworks also ship inside the active Xcode bundle (for example
`/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/…`).
The Swift bridge (`src/native/sim-hid-bridge.swift`) tries each known path
in order and exits with code `78` (`SIMULATORKIT_UNAVAILABLE`) if none of
them can be loaded. This keeps the failure mode deterministic — the Node
wrapper classifies that exit code as `InputBackendError` with
`code === 'SIMULATORKIT_UNAVAILABLE'` and the routing layer can fall
through to an already-supported tier.

## Why `dlopen` and not direct linking

- Private frameworks are not in any public SDK, so `-framework SimulatorKit`
  would require a host-specific search path and would make the project
  impossible to compile on machines without a matching Xcode.
- `dlopen` keeps load failures **recoverable at runtime** — a missing symbol
  surfaces as a structured JSON error on stdout, not a dyld crash.
- `dlopen` also isolates the blast radius of an Apple BC break: a broken
  framework cannot take the whole Node process down during module init.

All private-symbol resolution happens in `sim-hid-bridge.swift`. The
TypeScript side (`src/tools/sim-hid-input-backend.ts`) treats the bridge as
an opaque child process; it never dlopens anything itself.

## Contract between the Node wrapper and the Swift bridge

The bridge is spawned per call via `execFile`. The contract is deliberately
narrow so we can swap the Swift implementation later without touching TS.

### Argv

```
sim-hid-bridge <udid> tap    <x> <y> [duration]
sim-hid-bridge <udid> swipe  <x1> <y1> <x2> <y2> [duration]
sim-hid-bridge <udid> key    <hidUsage> [duration]
sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]
```

### Stdout (newline-terminated JSON)

- Success: `{ "ok": true, "kind": "<tap|swipe|key|button>", "udid": "...", "elapsed_ms": N }`
- Failure: `{ "ok": false, "error": "<message>", "code": "<MACHINE_CODE>" }`

### Exit codes

| Code | Meaning | Node-side mapping |
|---|---|---|
| `0`  | Success | resolve |
| `64` | Bad / missing arguments | `InputBackendError("BAD_ARGS")` |
| `69` | Sim device not found or not booted | `InputBackendError("DEVICE_NOT_BOOTED")` |
| `78` | Private framework failed to `dlopen` | `InputBackendError("SIMULATORKIT_UNAVAILABLE")` |
| `99` | Reserved — legacy PoC stub code (no longer emitted by the shipped bridge) | `InputBackendError("NOT_IMPLEMENTED")` |
| other | Unexpected | `InputBackendError("UNKNOWN")` with `stderr` surfaced |

Timeouts are enforced on the Node side (`SPAWN_TIMEOUT_MS = 10_000`). A
killed child classifies as `InputBackendError("SPAWN_TIMEOUT")`.

## BC-break monitoring strategy

Private API behaviour can drift silently between Xcode releases. We mitigate
that risk with three independent layers:

1. **Sentinel CI job (daily)** — `.github/workflows/sim-hid-sentinel.yml`
   runs `tests/ci/sim-hid-sentinel.test.ts` across a matrix of macOS
   runners every day at 06:00 UTC (and on any push touching
   `src/native/sim-hid-bridge.swift`). The sentinel probes
   `dlopen` for `SimulatorKit.framework` / `CoreSimulator.framework` and
   checks for the `IndigoHIDMessage*` symbols. A failure on a scheduled run
   opens (or updates) a `sentinel`-labelled GitHub issue so on-call sees it
   on github.com without Slack access.
2. **Fallback tiers stay wired** — Tier 1 activation does **not** remove
   `SimctlInputBackend`, `WebKitInputBackend`, or `AppleScriptInputBackend`.
   `getInputBackend()` only prefers `SimulatorKitHIDInputBackend` when the
   helper is present and resolvable; on exit `78`, on a missing binary, or
   on `OPENSAFARI_HEADLESS_ONLY=1` without a simhid backend, it drops to
   the next tier. This mirrors the default-deny pattern used for the
   AppleScript fallback introduced in #405.
3. **Structured error codes** — Every private-symbol entry point returns a
   stable exit code defined above. Consumers of `InputBackendError` can
   decide routing ("fall through on `SIMULATORKIT_UNAVAILABLE` or
   `NOT_IMPLEMENTED`, surface on `DEVICE_NOT_BOOTED`") without string
   parsing. Error messages for `SIMULATORKIT_UNAVAILABLE` /
   `NOT_IMPLEMENTED` embed a pointer to this document so CI operators can
   jump straight to the response playbook.
4. **One-time stderr notice** — The first time a process actually spawns
   `sim-hid-bridge`, `SimulatorKitHIDInputBackend` emits a single
   `[opensafari] SimulatorKitHIDInputBackend uses Apple private
   frameworks …` line via `console.error`. This makes the private-API
   dependency visible in MCP server logs and CI output without drowning
   them with per-call repetition.

## `idb` call-pattern comparison

Facebook's [`idb`](https://github.com/facebook/idb) (MIT) has used the same
private `SimulatorKit` HID path in production since 2018. OpenSafari's
bridge is **independently written** but follows the same Apple-maintained
symbol surface, so it's useful to know where the two implementations agree
and where they diverge. Divergences exist only when OpenSafari's
single-binary CLI contract (argv in, JSON on stdout) demands a simpler
dispatch shape than `idb`'s long-running Objective-C runtime.

| Aspect | `idb_companion` | `opensafari` (`sim-hid-bridge`) | Rationale |
|---|---|---|---|
| Framework loading | Link-time + weak symbols across `FBSimulatorControl` | Runtime `dlopen` of `/Library/Developer/PrivateFrameworks/SimulatorKit.framework` and `/…/CoreSimulator.framework` | We want to ship a single Mach-O that refuses to boot (exit 78) on a machine without Xcode, rather than failing at dyld load. |
| `SimDevice` resolution | `FBSimulatorSet` + Objective-C runtime walk | `SimServiceContext.sharedServiceContextForDeveloperDir:error:` → `defaultDeviceSetWithError:` → `availableDevices`/`devices` via `NSSelectorFromString` | Same symbols, different call shape — we avoid linking FB's wrapper classes so the bridge has no non-Apple dependencies. |
| HID client | `FBSimulatorHIDClient` (wraps `SimDeviceLegacyHIDClient`) | `_TtC12SimulatorKit24SimDeviceLegacyHIDClient` class name resolved via `NSClassFromString`, `initWithDevice:error:` called through `method_getImplementation` + `unsafeBitCast` | Drop FB's wrapper layer because we need exactly one code path per command; the raw legacy client is enough. |
| Tap event | `IndigoHIDMessageForMouseNSEvent(sp, wp, 0, kMouseDown/Up, screenSize, 0)` | Same C function, same arg layout. `screenSize` resolved from `SimDeviceType.mainScreenSize`. | Identical wire format — this is the arg shape Apple's daemon actually consumes. |
| Swipe event | `kMouseDragged` between `Down` / `Up`, interpolated over N steps | Same pattern, default 10 steps over 0.3 s | Matching step count keeps behaviour consistent with idb-trained users. |
| Key event | `IndigoHIDMessageForKeyboardArbitrary(hidUsage, down)` + `…(hidUsage, up)` | Same. | HID usage values come from the Apple HID Usage Tables (public spec). |
| Button event | `IndigoHIDMessageForButton(code, down)` / `(code, up)` | Same. `home=1, lock=2, soundUp=3, soundDown=4`. | Codes match the internal `FBSimulatorHIDButton` enum. |
| Send channel | `SimDeviceLegacyHIDClient sendMessage:freeWhenDone:completionQueue:completion:` | Same selector via `method_getImplementation` + `unsafeBitCast`. `freeWhenDone` is `false` — we let ARC own the message buffer so a crash in the daemon doesn't leak. | Same selector. |
| Transport | Persistent gRPC + long-running Obj-C server process | Short-lived child process per call; stdout = JSON, argv = command | MCP expects stateless tool invocations; a daemon would need a supervisor we don't want to own. |
| Arg encoding | Protobuf (`RawHIDEventRequest`) | CLI argv + JSON stdout envelope | Matches the existing `ax-bridge` contract in the same repo — reviewers only learn one pattern. |
| Timing | Tap dwell 0.08 s default | Tap dwell 0.05 s default, swipe dwell total/(steps+2) per segment | Our dwell is tuned against the simulator frame cadence, not gesture recognisers. |
| License | MIT | MIT | OpenSafari does **not** copy `idb` source. Cross-references in reviews must cite commit + file, never paste code. |

When in doubt — if a simulator rejects a message shape — the `idb` source
is the authoritative reference for the Apple contract. Re-read the matching
FB file, compare symbol layout, and update this table if we diverge. See
the `idb` directories `FBSimulatorControl/Session`, `CompanionLib`, and
`PrivateHeaders` for the canonical call paths.

## idb vs. opensafari call patterns

> **Disclaimer**: This table is a behavioural comparison drawn from public idb
> source references and opensafari's own code. No source was copied from idb.
> When refreshing this table, reviewers must re-cite the exact idb commit they
> used for reference in the PR description.

| Aspect | idb | opensafari sim-hid-bridge |
|---|---|---|
| Framework loading | Static link at build time | `dlopen` at runtime (`loadSimulatorKit` / `loadCoreSimulator` — `src/native/sim-hid-bridge.swift:49,:57`) |
| SimDevice resolution | `FBSimulatorSet` | CoreSimulator `dlsym` → `SimServiceContext` → `defaultDeviceSetWithError:` (`src/native/sim-hid-bridge.swift:127`) |
| Tap event | `IndigoHIDData` + `IOHIDEvent` via `FBSimulatorHIDEvent` | `IndigoHIDMessageForMouseNSEvent` resolved via `dlsym` (`src/native/sim-hid-bridge.swift:170`) |
| Key event | `FBKeyboardCommand` / `FBSimulatorHIDEvent` | `IndigoHIDMessageForKeyboardArbitrary` resolved via `dlsym` (`src/native/sim-hid-bridge.swift:171`) |
| Button event | `FBSimulatorButton` enum + `FBSimulatorHIDEvent` | `IndigoHIDMessageForButton` resolved via `dlsym` (`src/native/sim-hid-bridge.swift:172`) |
| Arg encoding | Protobuf over a gRPC/socket transport | CLI argv + JSON stdout (newline-terminated envelope) |
| Process model | Long-lived `FBSimulator` session | Short-lived `execFile` per call (`src/tools/sim-hid-input-backend.ts`) |
| Spawn timeout | idb default 10 s | `SPAWN_TIMEOUT_MS = 10_000` (`src/tools/sim-hid-input-backend.ts:35`) |

### Rationale for deliberate divergences

opensafari uses `execFile` per call for **process isolation and crash
containment**: a misbehaving or crashing Swift helper cannot corrupt the
long-lived Node MCP server process. idb's Protobuf transport is not adopted
because opensafari is a single-language (TypeScript) wrapper — the overhead of
a schema registry and generated types is unjustified for a thin argv/JSON
contract. `SPAWN_TIMEOUT_MS` is deliberately kept at 10 000 ms to match idb's
default so operators who already know idb have a familiar mental model for
latency budgets. Finally, frameworks are `dlopen`ed rather than linked so that
a binary-incompatible Apple framework update cannot take the Node process down
at dyld time — failure surfaces as a structured `SIMULATORKIT_UNAVAILABLE`
error and the routing layer falls through to the next input tier.

## License note

The `SimulatorKit` HID pattern is well-known in the community thanks to
Facebook's [`idb`](https://github.com/facebook/idb) (MIT). OpenSafari's
bridge is **independently written** from public framework headers, symbol
inspection, and Apple's dyld tooling. We do not copy or adapt `idb` source
files into the repository. If you do need to cross-reference `idb`, cite
the exact file and commit in the PR description — do not paste code.

## Maintenance contract

- Update this document in the same PR that adds or removes a private-symbol
  dependency. The `sim-hid-sentinel` workflow already fires on
  `src/native/sim-hid-bridge.swift` edits to catch drift; reviewers should
  treat a missing update to this file as a blocking comment.
- Bump the exit-code table above whenever a new failure mode is introduced.
  The Node side's `InputBackendErrorCode` union must stay in sync.
- Keep the Swift bridge defensive: every private symbol call must be
  wrapped in a nil check, and any failure must emit a structured JSON
  envelope before the process exits.

## Tracking

All work in this area is tracked under the
[SimulatorKitHIDInputBackend umbrella issue (#483)](https://github.com/shaun0927/opensafari/issues/483).
Relevant shipped PRs:

- [#487](https://github.com/shaun0927/opensafari/pull/487) — PoC: Swift
  bridge, Node wrapper, unit tests.
- [#510](https://github.com/shaun0927/opensafari/pull/510) — Swift bridge
  implementation (`IOHIDEvent` injection via `SimDeviceLegacyHIDClient`).
- [#511](https://github.com/shaun0927/opensafari/pull/511) — Tier 1
  activation in `getInputBackend()`.
- [#513](https://github.com/shaun0927/opensafari/pull/513) — Sentinel test
  suite (`tests/ci/sim-hid-sentinel.test.ts`).
- [#493](https://github.com/shaun0927/opensafari/issues/493) — Daily cron
  workflow + idb-pattern comparison (this document) + one-time stderr
  notice.

### #491 investigation

The Xcode 26 tap regression + the candidates we have already falsified
(mouse NSEvent coord units, `CreatePointerService` bracket, digitizer
IOHIDEvent → pointer wrapper) are tracked in
[docs/simhid-ios26-investigation.md](./simhid-ios26-investigation.md).
Read that file before adding a new candidate path so we don't reproduce
work already ruled out.
