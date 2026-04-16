#!/usr/bin/env bash
# build.sh — compile the minimal WebView fixture for iOS Simulator.
#
# Usage:
#   ./build.sh                          # build only
#   ./build.sh --install                # build + install to booted simulator
#   ./build.sh --device-id <UDID>       # build + install to specific device
#
# Requirements:
#   - macOS with Xcode 15+ (iOS 17+ SDK, for WKWebView.isInspectable)
#   - A booted iOS Simulator (for --install)
#
# Output:
#   build/WebViewFixture.app  — ready for `xcrun simctl install`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/WebViewFixture"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/WebViewFixture.app"
BUNDLE_ID="com.opensafari.fixtures.webview"
EXECUTABLE="WebViewFixture"

INSTALL=false
DEVICE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=true; shift ;;
    --device-id) DEVICE_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Detect SDK and minimum deployment target
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
# Use iOS 17.0 as minimum — WKWebView.isInspectable requires 16.4+
MIN_IOS="17.0"

# Determine architecture — arm64 on Apple Silicon, x86_64 on Intel
ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ]; then
  TARGET="${ARCH}-apple-ios${MIN_IOS}-simulator"
else
  TARGET="arm64-apple-ios${MIN_IOS}-simulator"
fi

echo "Building $EXECUTABLE for $TARGET ..."

# Clean
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"

# Compile Swift sources into a single executable
xcrun -sdk iphonesimulator swiftc \
  -target "$TARGET" \
  -sdk "$SDK_PATH" \
  -parse-as-library \
  -module-name "$EXECUTABLE" \
  -framework UIKit \
  -framework WebKit \
  -O \
  "$SRC_DIR/AppDelegate.swift" \
  "$SRC_DIR/ViewController.swift" \
  -o "$APP_DIR/$EXECUTABLE"

# Assemble .app bundle
cp "$SRC_DIR/Info.plist" "$APP_DIR/Info.plist"
echo -n "APPL????" > "$APP_DIR/PkgInfo"

# Ad-hoc sign (required for simulator install)
codesign --force --sign - "$APP_DIR"

echo "Built: $APP_DIR"
echo "Bundle ID: $BUNDLE_ID"

# Install if requested
if [ "$INSTALL" = true ]; then
  if [ -z "$DEVICE_ID" ]; then
    DEVICE_ID="booted"
  fi
  echo "Installing to device: $DEVICE_ID"
  xcrun simctl install "$DEVICE_ID" "$APP_DIR"
  echo "Installed $BUNDLE_ID on $DEVICE_ID"
fi
