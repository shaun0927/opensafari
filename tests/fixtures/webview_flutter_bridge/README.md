# webview_flutter_bridge — Flutter fixture for WebView↔Native E2E

## Purpose

A minimal single-screen Flutter app that embeds a `WebViewWidget` (via
`webview_flutter`) pointing at a bundled local HTML asset. The asset is
deterministic and makes **no network requests**, ensuring stable test
conditions.

The fixture is exercised by
`tests/integration/webview-native-context.live.test.ts` (opt-in via
`OPENSAFARI_LIVE_WEBVIEW=1`).

Bundle ID: `com.opensafari.fixtures.webviewbridge`

## Generating the Flutter scaffold

```sh
cd tests/fixtures/webview_flutter_bridge
flutter create --org com.opensafari.fixtures --project-name webview_flutter_bridge --platforms=ios .
```

After running `flutter create`, overwrite the generated files with the
versions in this directory:

```sh
# Overwrite entrypoint and manifest
cp lib/main.dart   <generated>/lib/main.dart
cp pubspec.yaml    <generated>/pubspec.yaml

# Add the local HTML asset
mkdir -p assets
cp assets/index.html <generated>/assets/index.html
```

> **Note:** Flutter camelCases the project name when deriving the bundle ID
> (`webview_flutter_bridge` → `webviewFlutterBridge`), so the generated
> `ios/Runner.xcodeproj/project.pbxproj` contains
> `com.opensafari.fixtures.webviewFlutterBridge` instead of the canonical
> `com.opensafari.fixtures.webviewbridge`. Running `build.sh` automatically
> rewrites those occurrences before the Xcode build, so the installed `.app`
> always carries the correct bundle ID. You do **not** need to patch the
> pbxproj manually.

## Building and installing

```sh
./build.sh --install --device-id <UDID>
```

`build.sh` will:
1. Run `flutter pub get`.
2. Rewrite `PRODUCT_BUNDLE_IDENTIFIER` in `ios/Runner.xcodeproj/project.pbxproj`
   from the Flutter-generated `com.opensafari.fixtures.webviewFlutterBridge` to
   the canonical `com.opensafari.fixtures.webviewbridge`.
3. Build for the iOS Simulator (`flutter build ios --simulator --debug --no-codesign`).
4. Install the `.app` bundle onto the simulator identified by `<UDID>` using
   `xcrun simctl install`.

## Screen layout

| Element                    | Key / identifier         | Role                          |
|---------------------------|--------------------------|-------------------------------|
| `ElevatedButton` (top)    | `load_webview_btn`       | Tapping renders the WebView   |
| `WebViewWidget`           | —                        | Shows `assets/index.html`     |
| `ElevatedButton` (bottom) | `native_confirm_btn`     | Sets status text to "confirmed" |
| `Text`                    | `native_status_text`     | Displays confirmation status  |
