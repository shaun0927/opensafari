# Physical-device TestFlight automation spike

Date: 2026-06-24 KST

## Decision

**No-go for production physical-device backend / full unattended Issue 7 yet.**

This host has modern Xcode/CoreDevice tooling and `devicectl` exposes useful physical-device primitives, but no tethered iOS device was attached during the spike. The production backend should not proceed until the same commands are proven on a dedicated, trusted, pre-authenticated TestFlight device.

## Host and tooling evidence

Environment observed on this machine:

```sh
sw_vers
# ProductName:        macOS
# ProductVersion:     26.3.1
# ProductVersionExtra: (a)
# BuildVersion:       25D771280a

xcode-select -p
# /Applications/Xcode.app/Contents/Developer

xcodebuild -version
# Xcode 26.4
# Build version 17E192

xcrun --find devicectl
# /Applications/Xcode.app/Contents/Developer/usr/bin/devicectl

xcrun devicectl --version
# Failed to load provisioning paramter list due to error: ... CoreDeviceError Code=1002 "No provider was found." ...
# `devicectl manage create` may support a reduced set of arguments.
# 518.27
```

`devicectl` is available and reports CoreDevice version `518.27`. The provisioning-provider warning appeared on every `devicectl` invocation, including successful read-only commands. For this spike it did not block listing devices or DDIs, but it is an operational risk for CI stability.

`devicectl --help` explicitly says script consumers should use `--json-output` files, not human stdout:

```text
--json-output <path>
  An optional path to write a JSON file with command results.
  Note: JSON output to a user-provided file on disk is the ONLY supported
  interface for scripts/programs to consume command output.
```

## Command observations

### List connected devices

Command:

```sh
xcrun devicectl list devices --timeout 15 --json-output /tmp/opensafari-physical-device-spike/devices.json
```

Observed stdout summary:

```text
Failed to load provisioning paramter list due to error: ... CoreDeviceError Code=1002 "No provider was found." ...
`devicectl manage create` may support a reduced set of arguments.
No devices found.
```

Observed JSON summary:

```json
{
  "info": {
    "commandType": "devicectl.list.devices",
    "jsonVersion": 3,
    "outcome": "success",
    "version": "518.27"
  },
  "result": { "devices": [] }
}
```

Cross-check with `xcdevice`:

```sh
xcrun xcdevice list
# Includes this Mac plus iOS simulators only.
# No physical iPhone/iPad entry was present.
```

Result: **no attached physical iOS device was available** for trusted/untrusted, launch, log, or screenshot runtime validation.

### Detect trusted / untrusted / unavailable state

Proven command surface:

```sh
xcrun devicectl list devices --json-output devices.json
xcrun xcdevice list
```

Evidence:

- `devicectl list devices` succeeded with an empty `result.devices` array.
- `devicectl help list devices` supports `--filter`, `--sort-by`, `--columns '*'`, and stable JSON output.
- `xcdevice list` emits device records with fields such as `available`, `ignored`, `simulator`, `platform`, `interface`, and `identifier` for the host/simulators.

Inference:

- A production detector can likely classify `NO_DEVICE` from an empty `devicectl` physical-device list.
- `UNAVAILABLE` may be classifiable from `xcdevice`/CoreDevice fields when a known device appears but reports unavailable.
- `UNTRUSTED` is not proven on this host because no untrusted device was attached. It must be validated with a real locked/untrusted iOS device before a backend depends on the exact JSON shape or error code.

Unknown:

- Exact `devicectl` JSON fields/errors for "Trust This Computer" pending, locked device, missing Developer Mode, or DDI mount failure.

### Launch installed bundle

Command availability:

```sh
xcrun devicectl help device process launch
```

Observed help summary:

```text
USAGE: devicectl device process launch [<options>] --device <uuid|ecid|serial_number|udid|name|dns_name> <bundle-identifier-or-path> [<command-line-arguments> ...]

--activate/--no-activate
  Launches the application in the foreground. (default: --activate)
  Whether or not to activate the application when starting it. Not supported on all platforms.

--terminate-existing
  Terminates any already-running instances of the app prior to launch. Not supported on all platforms.
```

Result:

- `devicectl` supports launching a bundle identifier and foreground activation in the CLI contract.
- This was **not executed** because no device was attached and no target bundle was supplied.
- Foregrounding TestFlight (`com.apple.TestFlight`) or a TestFlight-installed app is **supported by command shape but unproven** on a tethered real device.

### List installed apps and running processes

Command availability:

```sh
xcrun devicectl help device info apps
xcrun devicectl help device info processes
```

Observed help summary:

```text
USAGE: devicectl device info apps --device <id>
  --include-all-apps
  --bundle-id <bundle identifier>

USAGE: devicectl device info processes --device <id>
```

Result:

- Installed-app lookup by bundle ID is available in `devicectl`.
- Running-process listing is available in `devicectl`.
- Neither was executed because there was no physical device.

### Collect logs / diagnostics

Command availability:

```sh
xcrun devicectl help diagnose
xcrun devicectl help device sysdiagnose
xcrun devicectl help device copy from
```

Observed help summary:

```text
devicectl diagnose
  Gather diagnostic information from the local system and connected devices
  that have a mounted Developer Disk Image (DDI).

devicectl device sysdiagnose --device <id> [--destination <path>] [--gather-full-logs] [--dry-run-only]
  Gather a sysdiagnose for a device.

devicectl device copy from --device <id> --source <source> --domain-type <domain-type>
  Valid domain-type values include: temporary, appDataContainer,
  appGroupDataContainer, systemCrashLogs.
```

Result:

- Crash-log and sysdiagnose collection are exposed by `devicectl`.
- These are diagnostic/forensic collections, not a proven live `app_logs` equivalent.
- `--gather-full-logs` can be large and privacy-sensitive; it should not be a default CI path.
- No log command was executed against a device because no device was attached.

Unknown:

- Whether production can get lightweight, app-scoped live logs from physical iOS using only public Xcode CLI tooling.
- Whether TestFlight-installed app logs are visible without a development provisioning relationship.

### Screenshot / screen capture

Command availability checked:

```sh
xcrun devicectl help device info displays
xcrun devicectl help device
xcrun xctrace list devices
```

Observed help summary:

```text
devicectl device info displays --device <id>
  Get the device's current display information.

devicectl device subcommands include:
  copy, info, install, notification, orientation, process, reboot,
  sysdiagnose, uninstall
```

`xctrace list devices` observed only the Mac and simulators:

```text
== Devices ==
omofictions의 MacBook Pro (...)

== Simulators ==
iPad Pro 13-inch (M5) Simulator (...)
iPhone 16 Simulator (...)
iPhone 17 Simulator (...)
iPhone 17 Pro Simulator (...)
```

Result:

- `devicectl` exposes display metadata, but this host's help does **not** show a screenshot/screen-capture subcommand.
- No physical-device screenshot was taken because no device was attached.
- This spike does **not** prove that TestFlight can be screenshotted on a tethered real device via public Xcode CLI.

Unknown:

- Whether Xcode 26.4 has a separate public screenshot CLI for physical devices outside `devicectl`.
- Whether screenshots of TestFlight or StoreKit purchase sheets are blocked/redacted by iOS privacy policy on physical devices.

## Evidence

- `xcrun devicectl` exists at `/Applications/Xcode.app/Contents/Developer/usr/bin/devicectl`.
- `devicectl` version is `518.27`.
- `devicectl` stable scripting interface is `--json-output <path>`.
- `devicectl list devices` returned success with `result.devices: []`.
- `xcdevice list` showed this Mac and iOS simulators, not a physical iOS device.
- `devicectl device process launch` supports launching a bundle identifier/path and defaults to `--activate`.
- `devicectl device info apps` supports `--bundle-id` and `--include-all-apps`.
- `devicectl device info processes`, `device sysdiagnose`, `diagnose`, and `device copy from ... systemCrashLogs` are available.
- `devicectl` help inspected during this spike did not expose a screenshot command.
- iOS DDI metadata is present and usable:

```sh
xcrun devicectl list preferredDDI --timeout 15 --json-output /tmp/opensafari-physical-device-spike/preferredDDI.json
# Host CoreDevice version: 518.27
# The DDI used for the iOS platform:
# • hostDDI: file:///Library/Developer/DeveloperDiskImages/iOS_DDI/
# • buildUpdate: 17E192
# • isUsable: true
```

## Inference

- A small physical-device detector could safely start with `devicectl list devices --json-output` and classify `NO_DEVICE` when no physical iOS devices are returned.
- A physical-device launcher may be possible for TestFlight or a target bundle via `devicectl device process launch --device <id> <bundle-id>`.
- `devicectl` app/process listing could support preflight checks for "TestFlight installed" and "target app installed" once a device is present.
- Diagnostics collection can probably support failure evidence, but the default production evidence path should prefer smaller artifacts than full sysdiagnose.

## Unknown

- Exact JSON schema for connected trusted iPhone/iPad records.
- Exact errors for untrusted, locked, unavailable, Developer Mode disabled, no DDI, or pairing failures.
- Whether `com.apple.TestFlight` can be launched and foregrounded on a physical device by bundle ID.
- Whether a TestFlight-installed app can be foregrounded without debug entitlements.
- Whether a public, non-interactive physical-device screenshot command exists on this Xcode installation.
- Whether StoreKit/TestFlight screens can be captured on real devices without redaction.
- Whether live app logs are available for TestFlight builds using public Xcode CLIs.

## Host permissions and operational risks

- Requires Xcode-selected developer directory (`xcode-select -p`) and working `xcrun`.
- Requires CoreDevice support and compatible iOS Developer Disk Image. This host has an iOS DDI, but `devicectl` still prints a CoreDevice provider warning.
- Requires a USB or network-visible physical iOS device trusted by this Mac.
- Likely requires device unlock, Developer Mode, and a mounted DDI for deeper info/log commands.
- CI must treat `devicectl` human stdout as unstable and parse only `--json-output` files.
- `devicectl diagnose` / `sysdiagnose --gather-full-logs` can collect sensitive and large host/device logs; do not run by default.
- Foreground launch mutates device UI state even though it does not install/delete apps; run only on a dedicated device lane.
- Apple ID, 2FA, TestFlight invite acceptance, sandbox account state, and purchase state remain human/account prerequisites and are outside safe automation.

## Recommendation

Do **not** start full unattended Issue 7 now.

Recommended next step is a second, still spike-only pass with one dedicated physical iPhone/iPad attached and pre-consented for automation. That pass should capture stable JSON/error artifacts for:

1. no device,
2. trusted unlocked device,
3. locked device,
4. untrusted / trust-pending device,
5. TestFlight installed vs missing,
6. `devicectl device process launch --device <id> com.apple.TestFlight`,
7. launch target TestFlight app bundle,
8. app/process list after launch,
9. smallest acceptable log artifact,
10. screenshot or explicit proof that public Xcode CLI cannot capture one.

Production backend should proceed only if that pass proves: stable device state classification, TestFlight/target foreground launch, non-sensitive evidence collection, and a supported screenshot or an approved alternate visual-state source.
