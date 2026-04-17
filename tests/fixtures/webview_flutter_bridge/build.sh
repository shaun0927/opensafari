#!/usr/bin/env bash
# build.sh — build and optionally install the webview_flutter_bridge fixture.
#
# Usage:
#   ./build.sh                          # build only
#   ./build.sh --install                # build + install to booted simulator
#   ./build.sh --install --device-id <UDID>  # build + install to specific device
#
# Requirements:
#   - Flutter SDK on PATH (run `flutter --version` to verify)
#   - macOS with Xcode 15+ installed
#   - A booted iOS Simulator (for --install)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ID="com.opensafari.fixtures.webviewbridge"
APP_PATH="$SCRIPT_DIR/build/ios/iphonesimulator/Runner.app"

INSTALL=false
DEVICE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=true; shift ;;
    --device-id) DEVICE_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Verify flutter is available
if ! command -v flutter &>/dev/null; then
  echo "ERROR: 'flutter' not found on PATH." >&2
  echo "Install the Flutter SDK: https://docs.flutter.dev/get-started/install" >&2
  exit 1
fi

echo "==> flutter pub get"
(cd "$SCRIPT_DIR" && flutter pub get)

# Flutter derives the bundle ID from the project name using camelCase
# (webview_flutter_bridge → webviewFlutterBridge), producing
# com.opensafari.fixtures.webviewFlutterBridge in the generated pbxproj.
# Rewrite it to the canonical ID used by build.sh, the README, and the
# integration test so that `simctl launch` finds the installed app.
PBXPROJ="$SCRIPT_DIR/ios/Runner.xcodeproj/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
  echo "==> Rewriting PRODUCT_BUNDLE_IDENTIFIER in $PBXPROJ"
  sed -i '' \
    -e 's/PRODUCT_BUNDLE_IDENTIFIER = com\.opensafari\.fixtures\.webviewFlutterBridge\.RunnerTests;/PRODUCT_BUNDLE_IDENTIFIER = com.opensafari.fixtures.webviewbridge.RunnerTests;/g' \
    -e 's/PRODUCT_BUNDLE_IDENTIFIER = com\.opensafari\.fixtures\.webviewFlutterBridge;/PRODUCT_BUNDLE_IDENTIFIER = com.opensafari.fixtures.webviewbridge;/g' \
    "$PBXPROJ"
fi

echo "==> flutter build ios --simulator --debug --no-codesign"
(cd "$SCRIPT_DIR" && flutter build ios --simulator --debug --no-codesign)

echo "Built: $APP_PATH"
echo "Bundle ID: $BUNDLE_ID"

if [ "$INSTALL" = true ]; then
  if [ -z "$DEVICE_ID" ]; then
    DEVICE_ID="booted"
  fi
  echo "==> Installing to device: $DEVICE_ID"
  xcrun simctl install "$DEVICE_ID" "$APP_PATH"
  echo "Installed $BUNDLE_ID on $DEVICE_ID"
fi
