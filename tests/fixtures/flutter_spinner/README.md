# flutter_spinner

Deterministic spinner fixture for [opensafari issue #46](https://github.com/junghwan-oss/opensafari/issues/46) live integration tests.

The app renders **only** a `CircularProgressIndicator` (no Scaffold, no AppBar, no labels) for **exactly 8000 ms** after first build, then swaps to a `Text('Content ready')`. This is the exact AX-tree signature that `dist/sim-hid-bridge`'s `TRANSITIONAL_STATE_TIMEOUT` classification keys on.

## Bundle ID

```
com.opensafari.fixtures.flutterSpinnerQa
```

Deliberately distinct from the `flutter-qa-app` fixture (`com.opensafari.fixtures.flutterQaApp`) so the two can coexist on one simulator.

## Bootstrap (first time only)

This repository ships the Dart sources, pubspec, and build script only. The iOS Xcode project scaffold is regenerated on demand:

```sh
cd tests/fixtures/flutter_spinner
flutter create \
  --platforms=ios \
  --org com.opensafari.fixtures \
  --project-name flutter_spinner_qa .
```

Then open `ios/Runner.xcodeproj` (or edit `ios/Runner.xcodeproj/project.pbxproj`) and set:

```
PRODUCT_BUNDLE_IDENTIFIER = com.opensafari.fixtures.flutterSpinnerQa
```

on every build configuration (`Debug`, `Release`, `Profile`).

## Build & install

```sh
# Build and install on a booted simulator
./tests/fixtures/flutter_spinner/build.sh --device-id <udid> --install

# Or, equivalently, step by step:
cd tests/fixtures/flutter_spinner
flutter build ios --simulator --debug
xcrun simctl install <udid> build/ios/Debug-iphonesimulator/Runner.app
```

Note: the iOS simulator only supports `--debug` builds via `flutter build ios --simulator`. `--mode release` in `build.sh` is accepted for parity with `flutter-qa-app` but still produces a debug-simulator build.

## Verifying installation

```sh
xcrun simctl listapps <udid> | grep -q com.opensafari.fixtures.flutterSpinnerQa
```

## Used by

- `tests/integration/sim-hid-transitional.live.test.ts` — gated behind `OPENSAFARI_LIVE_TRANSITIONAL=1`.
