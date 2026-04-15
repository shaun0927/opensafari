# Private Apple Frameworks Used by OpenSafari

> Status: PoC (tracked in [#483](https://github.com/shaun0927/opensafari/issues/483)).
> The SimulatorKit HID path is **not yet activated** in the routing layer. This
> document describes the contract so future work (and code reviewers) know what
> guarantees the rest of the codebase may rely on.

OpenSafari keeps the set of private-framework dependencies small and
auditable. Every private symbol we touch is listed here together with:

1. Where the framework physically lives on disk.
2. How we load it (always `dlopen`, never link-time).
3. The behavioural contract with the TypeScript side.
4. The monitoring / fallback strategy for Apple BC breaks.

If you add a new private-framework call, you **must** update this file in
the same PR. Reviewers will block merges that skip this step.

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
| `99` | PoC stub — HID injection not yet implemented | `InputBackendError("NOT_IMPLEMENTED")` |
| other | Unexpected | `InputBackendError("UNKNOWN")` with `stderr` surfaced |

Timeouts are enforced on the Node side (`SPAWN_TIMEOUT_MS = 10_000`). A
killed child classifies as `InputBackendError("SPAWN_TIMEOUT")`.

## BC-break monitoring strategy

Private API behaviour can drift silently between Xcode releases. We mitigate
that risk with three independent layers:

1. **Sentinel CI job (daily)** — A nightly workflow will run
   `sim-hid-bridge <udid> tap 10 10` against a matrix of (macOS, Xcode)
   runners. If exit code `78` or `99` bubbles up on a version that used to
   return `0`, the job fails loudly and the existing tiers keep serving
   users. (Tracked in follow-up PR after #483 activation.)
2. **Fallback tiers stay wired** — The PoC does **not** remove
   `SimctlInputBackend`, `WebKitInputBackend`, or `AppleScriptInputBackend`.
   `getInputBackend()` will only prefer `SimulatorKitHIDInputBackend` when
   the helper is present and its smoke-tap succeeds; otherwise it drops to
   the next tier. This is the same default-deny pattern used for the
   AppleScript fallback introduced in #405.
3. **Structured error codes** — Every private-symbol entry point returns a
   stable exit code defined above. Consumers of `InputBackendError` can
   decide routing ("fall through on `SIMULATORKIT_UNAVAILABLE` or
   `NOT_IMPLEMENTED`, surface on `DEVICE_NOT_BOOTED`") without string
   parsing.

## License note

The `SimulatorKit` HID pattern is well-known in the community thanks to
Facebook's [`idb`](https://github.com/facebook/idb) (MIT). OpenSafari's
bridge is **independently written** from public framework headers, symbol
inspection, and Apple's dyld tooling. We do not copy or adapt `idb` source
files into the repository. If you do need to cross-reference `idb`, cite
the exact file and commit in the PR description — do not paste code.

## Maintenance contract

- Update this document in the same PR that adds or removes a private-symbol
  dependency. CI will grow a check for this once the sentinel job lands.
- Bump the exit-code table above whenever a new failure mode is introduced.
  The Node side's `InputBackendErrorCode` union must stay in sync.
- Keep the Swift bridge defensive: every private symbol call must be
  wrapped in a nil check, and any failure must emit a structured JSON
  envelope before the process exits.

## Tracking

All work in this area is tracked under issue
[#483 — `SimulatorKitHIDInputBackend`](https://github.com/shaun0927/opensafari/issues/483).
The PoC PR (this document's introduction) ships the Swift bridge, the Node
wrapper, and unit tests; routing activation and the sentinel CI job land in
follow-up PRs.
