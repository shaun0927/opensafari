# Live integration tests

The Jest suites under `tests/integration/` exercise opensafari against a real
booted iOS Simulator. They are **excluded from the default `npm test` run**
(`jest.config.js` lists `/tests/integration/` in `testPathIgnorePatterns`)
because they require a macOS host with Xcode + Simulator.app, real input
delivery, and — for the Flutter suite — a built sample app installed on the
target device.

Run them explicitly:

```bash
OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest tests/integration/<name>.live.test.ts \
  --runInBand --testPathIgnorePatterns=/node_modules/
```

`--testPathIgnorePatterns=/node_modules/` is required to override the default
`testPathIgnorePatterns` from `jest.config.js`; without it Jest re-applies the
exclusion and reports zero tests.

## Prerequisites

| Requirement | Why |
|---|---|
| macOS with Xcode 15+ and a working `xcrun simctl` | All input backends use simctl or AppleScript against Simulator.app |
| A booted iOS Simulator device (default UDID baked into the suites: iPhone 16 / iOS 26.4 — override via `OSF_DEVICE_ID`) | The bridge needs a target |
| Simulator.app open with a **visible device window** | The CGEvent / AppleScript backend clicks at on-screen coordinates; a hidden window means taps go to whatever is underneath |
| `OPENSAFARI_ALLOW_FOCUS_INPUT=1` | Default-deny opt-in for the focus-stealing CGEvent backend (see `src/tools/native-input-backend.ts`). Required on Xcode 26+ where `simctl io input` was removed and no WebKit context exists for native apps |

## Suites

### `issue-423-flutter.live.test.ts`

Covers the seven Flutter-specific items from the issue #423 verification
checklist. Requires the bundled fixture app to be built and installed:

```bash
# 1) Generate the iOS project on top of the committed fixture.
cd tests/integration/fixtures/flutter_sample
flutter create --platforms ios --project-name osftest .

# 2) Build for the simulator (debug, JIT) and install onto the booted device.
flutter build ios --simulator --debug
xcrun simctl install booted build/ios/iphonesimulator/Runner.app

# 3) Back to the repo root, run the suite.
cd ../../../..
OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest \
  tests/integration/issue-423-flutter.live.test.ts \
  --runInBand --testPathIgnorePatterns=/node_modules/
```

The `flutter create` step is local-only on purpose — only `lib/main.dart` and
`pubspec.yaml` are committed so the fixture stays small and platform files
(`ios/`, `android/`, `build/`) regenerate cleanly on any machine.

The fixture's bundle ID is `com.example.osftest`. Override with
`OSF_BUNDLE_ID` if you re-build it under a different identifier.

### Other suites

Sibling suites added in follow-up PRs (e.g. `issue-423-native.live.test.ts`,
`issue-423-perf.live.test.ts`) document their own setup at the top of the
file. They share the same opt-in model and the same `--testPathIgnorePatterns`
override.

## Why these are not in CI

CI does not run a desktop Simulator window, and the Tier-3 input backend
deliberately requires an explicit opt-in because it moves the physical mouse
cursor and brings Simulator.app to the foreground. Run these locally before
landing changes that touch `app_tap_element`, `app_type_element`, or the
input backend.
