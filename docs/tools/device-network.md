# `device_network_set` / `device_network_get`

Toggles the iOS Simulator's host-level network state so native apps
(Flutter, UIKit) see real `SocketException` /
`NSURLErrorNotConnectedToInternet` instead of the WebKit-only drops
provided by `network_offline` / `network_throttle`.

Tracked by [#640](https://github.com/shaun0927/opensafari/issues/640).
Landed across six PRs — this document covers the `pfctl` host setup
that PRs 3–5 depend on, and the NLC fallback situation.

## Why this exists

`network_offline` and `network_throttle` inject JavaScript into the
WebKit page context (`fetch` / `XMLHttpRequest` shim). They cannot
affect `URLSession` or `dart:io HttpClient`, so a Flutter release
build that reads a cached chapter offline has no way to be verified
in CI — the API fallback silently succeeds over the real network.

The iOS Simulator shares the host's network stack, so cutting
simulator traffic means cutting host outbound traffic. On macOS
there are exactly two supported mechanisms:

| Mechanism | Status | Notes |
|---|---|---|
| `pfctl` | **Primary, wired in PR 3** | Deterministic, scriptable, requires one-time sudoers + `/etc/pf.conf` setup. |
| Network Link Conditioner (NLC) | **Stub only** | No public macOS CLI exists for enabling/disabling NLC; prefPane UI scripting is too brittle to ship. See the [NLC section](#network-link-conditioner-nlc) below. |

Everything else (`simctl status_bar`, `flutter_network` proxy,
per-app filtering) either does not actually drop packets or is
out of scope (see the issue body).

## One-time host setup (required for `pfctl` mechanism)

The tool refuses to silently stack rules on a machine that isn't
configured. You must do the three steps below exactly once per host.

### 1. Enable pf

```sh
sudo pfctl -E
```

Verify with `sudo pfctl -s info` — expect `Status: Enabled`.
If `Status: Disabled`, the `pfctl` mechanism raises
`PfctlPfDisabledError` at `apply()` time.

### 2. Register the anchor in `/etc/pf.conf`

Add an `anchor` line so pf actually evaluates rules loaded into
our dedicated anchor. A minimal `/etc/pf.conf` that preserves the
default rules while adding the anchor looks like:

```conf
# Default rules from the stock /etc/pf.conf
scrub-anchor "com.apple/*"
nat-anchor "com.apple/*"
rdr-anchor "com.apple/*"
dummynet-anchor "com.apple/*"
anchor "com.apple/*"
load anchor "com.apple" from "/etc/pf.anchors/com.apple"

# opensafari #640 — simulator-bound network blocker
anchor "opensafari-simdevnet"
```

Re-load the config after editing:

```sh
sudo pfctl -f /etc/pf.conf
```

### 3. Grant passwordless `pfctl`

Create `/etc/sudoers.d/opensafari` (use `sudo visudo -f
/etc/sudoers.d/opensafari`, *not* `echo >`):

```
# opensafari #640 — device_network_set/get need passwordless pfctl
your-username ALL=(root) NOPASSWD: /sbin/pfctl
```

Replace `your-username` with your login name. Verify with:

```sh
sudo -n /sbin/pfctl -sr   # must succeed without a password prompt
```

If this fails, `PfctlBlocker.isAvailable()` returns `false` and the
tool reports `NetworkBlockerUnavailableError`.

## Usage

```jsonc
// Go offline
{
  "tool": "mcp__opensafari__device_network_set",
  "args": { "mode": "offline" }
}

// Check state
{
  "tool": "mcp__opensafari__device_network_get",
  "args": {}
}

// Restore connectivity
{
  "tool": "mcp__opensafari__device_network_set",
  "args": { "mode": "online" }
}
```

- `offline` and `airplane` share a code path and are interchangeable
  strings for intent.
- `mechanism` defaults to `"auto"` and currently always resolves to
  `pfctl`; pass `"pfctl"` explicitly to fail fast if the setup above
  is missing.
- Multiple simulators can request `offline` concurrently; the
  host-wide rule only reverts when the **last** simulator returns
  to `online`.

## Crash safety

The server registers a cleanup handler at `apply()` time that
flushes the anchor on `SIGINT` / `SIGTERM` / normal exit. For
`SIGKILL` or host crashes where no handler gets to run, the next
server start runs **startup reconciliation** — the first call to
`device_network_set` probes the anchor via `pfctl -a … -sr` and
flushes any stale rules before accepting the new request.

Net effect: host connectivity is never left broken for longer than
the time between crash and the next `device_network_set` call.

## Network Link Conditioner (NLC)

> **Status (2026-04, `develop`):** NLC is *scaffolded* in the
> mechanism abstraction (PR 2) but `apply()` raises
> `NetworkBlockerNotImplementedError` with a pointer to this
> section.

### Why NLC is not wired

Apple's Network Link Conditioner is distributed with the "Additional
Tools for Xcode" package as a System Preferences panel. It has no
public CLI for enable/disable:

- `defaults write com.apple.networklinkconditioner …` edits prefs
  but does **not** activate the filter.
- No `launchctl` job or `networksetup` verb toggles it.
- The prefPane uses a private Network Extension on macOS 11+; any
  wrapper that toggles it through UI scripting (`osascript`) needs
  Accessibility permission and breaks on every macOS UI refresh.
- A signed Network Extension we ship ourselves would require
  Apple Developer ID + notarisation and is out of scope for this
  project.

### Practical implication

NLC as a *distinct* mechanism doesn't buy anything pfctl doesn't
already deliver on the same host. NLC itself uses pf + `dnctl`
under the hood. If you cannot configure passwordless pfctl, you
cannot reliably drive NLC either.

If you have a real workflow that needs NLC specifically, open an
issue describing the scenario — we'll evaluate shipping a signed
helper or a well-audited AppleScript path.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NetworkBlockerUnavailableError: sudo pfctl requires a passwordless sudoers rule` | `/etc/sudoers.d/opensafari` missing or wrong username | Step 3 above |
| `PfctlPfDisabledError: pf is not enabled on this host` | `pfctl -E` never run, or host reboot dropped the state | Step 1 above |
| `offline` returns 200 but Flutter traffic still succeeds | `/etc/pf.conf` missing the `anchor "opensafari-simdevnet"` line | Step 2 above |
| `mechanism_conflict` | Another simulator is offline under a different mechanism | Set all simulators to `online` before switching mechanism |
| Stale host-wide block after crash | Expected; cleared on next `device_network_set` call | None — startup reconciliation handles it |

## Related

- Upstream consumer need: [Omofictions/Omofictions-App#31](https://github.com/Omofictions/Omofictions-App/issues/31) (S27 close-gate)
- Issue thread: [#640](https://github.com/shaun0927/opensafari/issues/640)
